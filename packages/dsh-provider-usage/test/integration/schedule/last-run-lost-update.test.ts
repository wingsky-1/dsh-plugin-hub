/**
 * dsh-provider-usage — integration（#1142 探针）：schedule/lastRun 的 lost-update 回归。
 *
 * 被测事实（根因）：协调器在临界区外用一次 `read(root)` 取快照、预计算 advanced，再以
 * `write(root, () => advanced)` 把**预计算值**当 patch 交回更新原语（scheduler.ts 的
 * finishHalfCommits 与 reconcile 两处）。更新原语本会在 per-root 链内重读最新文件快照后
 * 调 patch（store.ts updateLastRun），patch 无视入参即丢弃链上更新的快照——另一写方
 * （preset 保存 / 执行器推进）在「读到写」窗口内落盘的推进被整段覆盖。
 *
 * 本文件用可控注入复刻该窗口：注入的 readLastRun 取走快照后，其内径直经 updateLastRun
 * （同一 per-root 链、同一隔离落盘根）推进一步，模拟并发写方落在窗口内。三条交错各证一条
 * 不变量（断言一律打真实落盘文件 + 真实账本）：
 * - 双写覆盖：reconcile 的旧 index 事实不得盖掉窗口内更新的窗口；
 * - 重启补完：recoverFence 补完半提交不得丢其它 period 的并发推进，且补完幂等（无重复写）；
 * - 单调失效：写回对写时快照单调不回退、重放同一事实不再写、账本快照与落盘互证。
 *
 * 运行：`node --test <本文件>`（Node 24 内置类型剥离）。本文件同时落在 vitest 收集面内，
 * 故 runner 双模：VITEST 环境取 vitest 的 it，其余取 node:test 的 it；断言只走
 * node:assert/strict，两个 runner 判红口径一致。
 *
 * 纪律：落盘一律 mkdtemp 隔离根（产物零污染）；零墙钟（now 固定）、零网络。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReportPeriod } from "../../../src/server/config/interface.ts";
import {
  createReportStateCoordinator,
  createRetryLedger,
  readLastRun,
  retryFenceFile,
  updateLastRun,
  writeLastRun,
  type RetrySeed,
} from "../../../src/server/schedule/interface.ts";

/** runner 双模：node:test（`node --test`）与 vitest（仓库测试面）同一份用例体。 */
const { it } = (
  process.env.VITEST === undefined ? await import("node:test") : await import("vitest")
) as {
  it: (name: string, fn: () => Promise<void> | void) => unknown;
};

type LastRun = Partial<Record<ReportPeriod, string>>;

const NOW = 1_700_000_000_000;
const PERIODS: readonly ReportPeriod[] = ["daily", "weekly", "monthly"];
const DAILY: RetrySeed = {
  period: "daily",
  key: "2026-09-23",
  startDay: "2026-09-23",
  endDay: "2026-09-23",
  route: { provider: "probe-provider", model: "probe-model" },
};
// 账本窗口键口径（retry-ledger isValidWindow）：weekly 与 daily 同为日期键，且 key === startDay
// （2026-W38 形态会被 parseEntryIdentity 拒 → "invalid retry ledger entry"）。
const WEEKLY: RetrySeed = {
  period: "weekly",
  key: "2026-09-14",
  startDay: "2026-09-14",
  endDay: "2026-09-20",
  route: { provider: "probe-provider", model: "probe-model" },
};

/** 隔离落盘根（测试纪律：产物零污染）。 */
function scratch(): string {
  return mkdtempSync(join(tmpdir(), "last-run-lost-update-"));
}

/** 推进语义的同口径副本（被测点：patch 必须在**写时**快照上重算，而非接受预计算值）。 */
function advance(state: LastRun, period: ReportPeriod, key: string): LastRun {
  const old = state[period];
  return old === undefined || key > old ? { ...state, [period]: key } : state;
}

/**
 * 可控 read：先取走快照（拷贝语义由 readLastRun 保证），再让另一写方于「读到写」窗口内
 * 经同一 per-root 链径直落盘一步。只在该协调器的首次读取触发一次——交错可控、无墙钟。
 */
function readWithConcurrentWriter(
  hook: (root: string) => Promise<void>,
): (root: string) => Promise<LastRun> {
  let fired = false;
  return async (root: string) => {
    const snapshot = await readLastRun(root);
    if (!fired) {
      fired = true;
      await hook(root);
    }
    return snapshot;
  };
}

/** 账本快照⇔落盘互证：已清算的 key 必须 ≤ 落盘窗口；未清算的条目必须仍 > 落盘窗口。 */
function assertLedgerAgreesWithPersisted(
  cleared: readonly { period: ReportPeriod; key: string }[],
  live: readonly { period: ReportPeriod; key: string }[],
  persisted: LastRun,
): void {
  for (const { period, key } of cleared) {
    const done = persisted[period];
    assert.ok(done !== undefined && done >= key, `已清算 ${period}:${key} 未反映到落盘：${done}`);
  }
  for (const { period, key } of live) {
    const done = persisted[period];
    assert.ok(
      done === undefined || key > done,
      `未清算 ${period}:${key} 已被落盘窗口越过：${done}`,
    );
  }
}

it("双写覆盖：reconcile 的旧快照 patch 不得盖掉窗口内的新推进（#1142）", async () => {
  const root = scratch();
  try {
    await writeLastRun(root, { daily: "2026-09-22" });
    const ledger = createRetryLedger(root, {
      now: () => NOW,
      createCycleId: () => "cycle-clobber",
    });
    const claim = await ledger.beginAttempt(DAILY, NOW);
    assert.ok(claim !== null, "expected claim");

    const coordinator = createReportStateCoordinator({
      root,
      ledger,
      now: () => NOW,
      readLastRun: readWithConcurrentWriter(async (r) => {
        // 另一写方（preset / 执行器）在 read→write 窗口内把 daily 推到更新的窗口。
        await updateLastRun(r, (prev) => advance(prev, "daily", "2026-09-25"));
      }),
    });
    await coordinator.reconcile({ daily: "2026-09-22" }, [
      { period: "daily", key: DAILY.key, cycleId: claim.cycleId },
    ]);

    const persisted = await readLastRun(root);
    // 旧实现：预计算 advanced（daily=2026-09-23）盖掉窗口内的 2026-09-25 → 回退（lost update）。
    assert.equal(persisted.daily, "2026-09-25");
    const live = await ledger.list();
    assertLedgerAgreesWithPersisted([{ period: "daily", key: DAILY.key }], live, persisted);
    // 无重复：同一 key 至多一条账本记录。
    const keys = live.map((entry) => `${entry.period}:${entry.key}`);
    assert.equal(new Set(keys).size, keys.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("重启补完：recoverFence 不得丢窗口内其它 period 的推进，且补完幂等（无重复写）", async () => {
  const root = scratch();
  try {
    await writeLastRun(root, { daily: "2026-09-22" });
    const ledger = createRetryLedger(root, {
      now: () => NOW,
      createCycleId: () => "cycle-restart",
    });
    const claim = await ledger.beginAttempt(DAILY, NOW);
    assert.ok(claim !== null, "expected claim");
    // 半提交现场：persist 已落盘（半提交标记在围栏），lastRun / clear 未完成 → 崩溃重启。
    mkdirSync(join(root, "reports"), { recursive: true });
    writeFileSync(
      retryFenceFile(root),
      JSON.stringify({
        schema: 1,
        commits: [{ period: "daily", key: DAILY.key, cycleId: claim.cycleId }],
        storageTerminals: [],
      }),
    );

    const coordinator = createReportStateCoordinator({
      root,
      ledger,
      now: () => NOW,
      readLastRun: readWithConcurrentWriter(async (r) => {
        await updateLastRun(r, (prev) => advance(prev, "weekly", "2026-W40"));
      }),
    });
    await coordinator.recoverFence();

    const persisted = await readLastRun(root);
    assert.equal(persisted.daily, DAILY.key); // 半提交补完：lastRun 推进
    // 旧实现：`() => advanced` 用重启时的旧快照整段覆盖 → 并发写方的 weekly 丢失（回退为 undefined）。
    assert.equal(persisted.weekly, "2026-W40");
    assert.deepEqual(await ledger.list(), []); // 清账恰好一次
    assertLedgerAgreesWithPersisted([{ period: "daily", key: DAILY.key }], [], persisted);

    // 幂等：围栏已空，再补完不产生第二次写（无重复补完）。
    let writes = 0;
    const again = createReportStateCoordinator({
      root,
      ledger,
      now: () => NOW,
      readLastRun,
      updateLastRun: async (r, patch) => {
        writes += 1;
        await updateLastRun(r, patch);
      },
    });
    await again.recoverFence();
    assert.equal(writes, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("单调失效：写回对写时快照不回退、重放同事实不再写、账本与落盘互证", async () => {
  const root = scratch();
  try {
    await writeLastRun(root, {});
    let sequence = 0;
    const ledger = createRetryLedger(root, {
      now: () => NOW,
      createCycleId: () => `cycle-${(sequence += 1)}`,
    });
    const daily = await ledger.beginAttempt(DAILY, NOW);
    const weekly = await ledger.beginAttempt(WEEKLY, NOW);
    assert.ok(daily !== null && weekly !== null, "expected claims");
    const facts = [
      { period: "daily" as const, key: DAILY.key, cycleId: daily.cycleId },
      { period: "weekly" as const, key: WEEKLY.key, cycleId: weekly.cycleId },
    ];

    const trace: { prev: LastRun; next: LastRun }[] = [];
    const coordinator = createReportStateCoordinator({
      root,
      ledger,
      now: () => NOW,
      readLastRun: readWithConcurrentWriter(async (r) => {
        // 窗口内并发推进：两个 period 都被推到比 index 事实更新的窗口。
        await updateLastRun(r, (prev) =>
          advance(advance(prev, "daily", "2026-09-24"), "weekly", "2026-09-21"),
        );
      }),
      updateLastRun: async (r, patch) => {
        const prev = await readLastRun(r); // 写时快照
        await updateLastRun(r, patch);
        trace.push({ prev, next: await readLastRun(r) });
      },
    });

    await coordinator.reconcile(await readLastRun(root), facts);

    // 单调：每次写回的每个 period 都不得低于写时快照。
    for (const { prev, next } of trace) {
      for (const period of PERIODS) {
        const before = prev[period];
        if (before === undefined) continue;
        const after = next[period];
        assert.ok(
          after !== undefined && after >= before,
          `${period} 写回回退（单调失效）：${before} → ${after}`,
        );
      }
    }

    const persisted = await readLastRun(root);
    assert.equal(persisted.daily, "2026-09-24");
    assert.equal(persisted.weekly, "2026-09-21");
    assertLedgerAgreesWithPersisted(
      facts.map(({ period, key }) => ({ period, key })),
      await ledger.list(),
      persisted,
    );

    // 无重复：同一事实重放不再落盘。
    const before = trace.length;
    await coordinator.reconcile(persisted, facts);
    assert.equal(trace.length, before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
