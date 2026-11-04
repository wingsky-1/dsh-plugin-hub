// Shape-only support module; all executable assertion bodies are moved verbatim.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRetryLedger,
  retryLedgerFile,
  type RetryAttemptInput,
  type RetryEntry,
  type RetryFailure,
  type RetryLedgerPort,
  type RetrySeed,
} from "../../../../src/server/schedule/interface.ts";

const seed: RetrySeed = {
  period: "daily",
  key: "2026-09-23",
  startDay: "2026-09-23",
  endDay: "2026-09-23",
  route: {
    provider: "deepseek",
    model: "deepseek-chat",
    reasoningEffort: "vendor::deep",
  },
};

const transient: RetryFailure = { code: "upstream-unavailable", kind: "transient" };

let savedDshHome: string | undefined;

let home: string;

let root: string;

let now: number;

let cycleSequence: number;

function newLedger(
  options: {
    renameFile?: (from: string, to: string) => Promise<void>;
    createCycleId?: () => string;
  } = {},
): RetryLedgerPort {
  return createRetryLedger(root, {
    now: () => now,
    createCycleId:
      options.createCycleId ??
      (() => {
        cycleSequence += 1;
        return `cycle-${cycleSequence}`;
      }),
    ...(options.renameFile === undefined ? {} : { renameFile: options.renameFile }),
  });
}

async function makeTerminal(
  ledger: RetryLedgerPort,
  input: RetryAttemptInput,
  failedAt: number,
): Promise<RetryEntry> {
  const claim = await ledger.beginAttempt(input, failedAt);
  if (claim === null) throw new Error("expected retry claim");
  const terminal = await ledger.recordFailure(
    claim,
    { code: "auth-failed", kind: "permanent" },
    failedAt,
  );
  if (terminal === null) throw new Error("expected terminal entry");
  return terminal;
}

export function registerRetryLedgerObservationCases(): void {
  it("两 attempt 按字段累计，缺失字段保持 null，重启读取观测事实", async () => {
    const first = newLedger();
    const firstClaim = await first.beginAttempt(seed, now);
    if (firstClaim === null) throw new Error("expected first claim");
    const firstEntry = await first.recordAttempt(firstClaim, {
      attempt: 1,
      result: "failure",
      code: "empty-output",
      status: "retry",
      durationMs: 125,
      tokens: {
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: null,
        totalTokens: 15,
        cacheReadTokens: 2,
        cacheWriteTokens: null,
      },
    });
    if (firstEntry === null) throw new Error("expected first observation");
    const waiting = await first.recordFailure(
      firstEntry,
      { code: "empty-output", kind: "empty-output" },
      now,
    );
    if (waiting === null) throw new Error("expected waiting entry");
    const secondClaim = await first.beginAttempt(
      { ...seed, cycleId: waiting.cycleId },
      waiting.nextRetryAt!,
    );
    if (secondClaim === null) throw new Error("expected second claim");
    const secondEntry = await first.recordAttempt(secondClaim, {
      attempt: 2,
      result: "success",
      code: null,
      status: "success",
      durationMs: 75,
      tokens: {
        inputTokens: 4,
        outputTokens: null,
        reasoningTokens: 3,
        totalTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: 1,
      },
    });
    if (secondEntry === null) throw new Error("expected second observation");
    const persisted = await newLedger().get(seed.period, seed.key);
    expect(persisted?.attemptObservations).toHaveLength(2);
    expect(persisted?.usage).toEqual({
      inputTokens: 14,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      durationMs: 200,
    });
  });

  it("缺文件为空；initial claim 写 schema=1 + records[period][key]，目录/文件私有", async () => {
    const ledger = newLedger();
    expect(await ledger.list()).toEqual([]);

    const claim = await ledger.beginAttempt(seed, now);
    expect(claim).toMatchObject({
      cycleId: "cycle-1",
      entry: {
        phase: "in-flight",
        attempts: 0,
        maxAttempts: 5,
        route: seed.route,
      },
    });

    const file = retryLedgerFile(root);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    expect(raw).toEqual({
      schema: 1,
      records: {
        daily: {
          "2026-09-23": {
            period: "daily",
            key: "2026-09-23",
            startDay: "2026-09-23",
            endDay: "2026-09-23",
            route: seed.route,
            attempts: 0,
            maxAttempts: 5,
            nextRetryAt: null,
            terminal: false,
            reason: null,
            cycleId: "cycle-1",
            phase: "in-flight",
            attemptObservations: [],
            usage: {
              inputTokens: null,
              outputTokens: null,
              reasoningTokens: null,
              totalTokens: null,
              cacheReadTokens: null,
              cacheWriteTokens: null,
              durationMs: null,
            },
          },
        },
      },
    });
    expect(statSync(join(root, "reports")).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, "reports")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
}

export function registerRetryLedgerTransitionCases(): void {
  it("1/2/4/8/16 分钟跨 factory 重建保持 attempts；第 5 次 retry 失败 terminal", async () => {
    let ledger = newLedger();
    let claim = await ledger.beginAttempt(seed, now);
    if (claim === null) throw new Error("expected initial claim");
    const delays = [60_000, 120_000, 240_000, 480_000, 960_000];

    for (let index = 0; index < delays.length; index += 1) {
      const failedAt = now + index * 1_000;
      const failed = await ledger.recordFailure(claim, transient, failedAt);
      if (failed === null) throw new Error("expected waiting entry");
      expect(failed.attempts).toBe(index + 1);
      expect(failed.nextRetryAt).toBe(failedAt + delays[index]);

      ledger = newLedger();
      claim = await ledger.beginAttempt({ ...seed, cycleId: failed.cycleId }, failed.nextRetryAt!);
      if (claim === null) throw new Error("expected persisted claim");
    }

    const terminal = await ledger.recordFailure(claim, transient, now + 10_000);
    expect(terminal).toMatchObject({
      attempts: 5,
      maxAttempts: 5,
      nextRetryAt: null,
      terminal: true,
      reason: { code: "upstream-unavailable", kind: "transient" },
      phase: "terminal",
    });
    expect(await newLedger().list()).toEqual([terminal]);
  });

  it("force durable reset 新 cycle；旧 cycle 的 claim/failure/clear 均 CAS 丢弃", async () => {
    const ledger = newLedger();
    const oldClaim = await ledger.beginAttempt(seed, now);
    if (oldClaim === null) throw new Error("expected old claim");
    const forced = await ledger.beginForce(
      {
        ...seed,
        route: { provider: "new-provider", model: "new-model" },
      },
      now + 1,
    );

    expect(forced).toMatchObject({
      attempts: 0,
      terminal: false,
      reason: null,
      nextRetryAt: now + 1,
      phase: "waiting",
      cycleId: "cycle-2",
    });
    expect(await ledger.beginAttempt({ ...seed, cycleId: oldClaim.cycleId }, now + 1)).toBeNull();
    expect(await ledger.beginAttempt(seed, now + 1)).toBeNull();
    expect(await ledger.recordFailure(oldClaim, transient, now + 2)).toBeNull();
    expect(await ledger.clear(oldClaim)).toBe(false);
    expect(await ledger.get(seed.period, seed.key)).toEqual(forced);

    const newClaim = await ledger.beginAttempt({ ...seed, cycleId: forced.cycleId }, now + 1);
    if (newClaim === null) throw new Error("expected forced claim");
    expect(await ledger.clear(oldClaim)).toBe(false);
    expect(await ledger.clear(newClaim)).toBe(true);
    expect(await ledger.list()).toEqual([]);
  });

  it("同 cycle 旧 attempt 的延迟 failure/clear 不得污染当前 attempt", async () => {
    const ledger = newLedger();
    const first = await ledger.beginAttempt(seed, now);
    if (first === null) throw new Error("expected first claim");
    const waiting = await ledger.recordFailure(first, transient, now);
    if (waiting === null) throw new Error("expected waiting entry");
    expect(await ledger.clear(first)).toBe(false);

    const second = await ledger.beginAttempt(
      { ...seed, cycleId: waiting.cycleId },
      waiting.nextRetryAt!,
    );
    if (second === null) throw new Error("expected second claim");
    expect(await ledger.recordFailure(first, transient, waiting.nextRetryAt!)).toBeNull();
    expect(await ledger.clear(first)).toBe(false);
    expect(await ledger.get(seed.period, seed.key)).toEqual(second.entry);
    expect(await ledger.clear(second)).toBe(true);
  });
}

export function registerRetryLedgerRecoveryCases(): void {
  it("listDue 只返回已到期非终态且 key>lastRun 的跨日 retry", async () => {
    const ledger = newLedger();
    const dueClaim = await ledger.beginAttempt(seed, now);
    if (dueClaim === null) throw new Error("expected due claim");
    const due = await ledger.recordFailure(dueClaim, transient, now);
    if (due === null) throw new Error("expected waiting entry");
    await ledger.beginForce(
      {
        ...seed,
        key: "2026-09-24",
        startDay: "2026-09-24",
        endDay: "2026-09-24",
      },
      now + 120_000,
    );
    await makeTerminal(
      ledger,
      { ...seed, key: "2026-09-25", startDay: "2026-09-25", endDay: "2026-09-25" },
      now,
    );

    expect(
      (await ledger.listDue(due.nextRetryAt!, { daily: "2026-09-22" })).map(({ key }) => key),
    ).toEqual([seed.key]);
  });

  it("recover 只把 initial/in-flight 转 waiting；waiting 保留 nextRetryAt 且不增 attempts", async () => {
    let ledger = newLedger();
    const waitingFailure = await ledger.recordFailure(
      (await ledger.beginAttempt(seed, now))!,
      transient,
      now,
    );
    if (waitingFailure === null) throw new Error("expected waiting");
    const inFlight = await ledger.beginAttempt(
      { ...seed, key: "2026-09-22", startDay: "2026-09-22", endDay: "2026-09-22" },
      now,
    );
    if (inFlight === null) throw new Error("expected in-flight claim");

    ledger = newLedger();
    const recovered = await ledger.recover(now + 10_000);
    expect(recovered).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: seed.key,
          phase: "waiting",
          attempts: 1,
          nextRetryAt: waitingFailure.nextRetryAt,
        }),
        expect.objectContaining({
          key: "2026-09-22",
          phase: "waiting",
          attempts: 0,
          nextRetryAt: now + 10_000,
        }),
      ]),
    );
    expect((await ledger.get(seed.period, seed.key))?.nextRetryAt).toBe(waitingFailure.nextRetryAt);
  });
}

export function registerRetryLedgerStorageCases(): void {
  it("坏 JSON 先 no-clobber 取证隔离，再 fail-closed；后续调用绝不把缺失文件当空", async () => {
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true, mode: 0o700 });
    const file = retryLedgerFile(root);
    writeFileSync(file, "{ definitely-not-json", { mode: 0o600 });

    const ledger = newLedger();
    await expect(ledger.list()).rejects.toMatchObject({ code: "retry-ledger-corrupt" });
    expect(existsSync(file)).toBe(false);
    const backups = readdirSync(reports).filter((name) =>
      name.startsWith("retry-ledger.json.bak-"),
    );
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(reports, backups[0]!), "utf8")).toBe("{ definitely-not-json");
    expect(statSync(join(reports, backups[0]!)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(reports, "retry-ledger.json.corrupt"))).toBe(true);

    await expect(newLedger().list()).rejects.toMatchObject({ code: "retry-ledger-corrupt" });
    expect(readdirSync(reports).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("损坏隔离 no-clobber 且取证备份有界为 5 份", async () => {
    const reports = join(root, "reports");
    mkdirSync(reports, { recursive: true, mode: 0o700 });
    for (let age = 5; age >= 1; age -= 1) {
      writeFileSync(join(reports, `retry-ledger.json.bak-${now - age}`), `old-${age}`, {
        mode: 0o600,
      });
    }
    const protectedCandidate = join(reports, `retry-ledger.json.bak-${now}`);
    writeFileSync(protectedCandidate, "existing-evidence", { mode: 0o600 });
    writeFileSync(retryLedgerFile(root), "not-json", { mode: 0o600 });

    await expect(newLedger().list()).rejects.toMatchObject({ code: "retry-ledger-corrupt" });

    expect(readFileSync(protectedCandidate, "utf8")).toBe("existing-evidence");
    const newBackup = `retry-ledger.json.bak-${now}-1`;
    expect(readFileSync(join(reports, newBackup), "utf8")).toBe("not-json");
    expect(
      readdirSync(reports).filter((name) => name.startsWith("retry-ledger.json.bak-")),
    ).toHaveLength(5);
  });

  it("rename 前失败会删除已 fsync 的 0600 临时文件", async () => {
    let temporaryObserved = "";
    const ledger = newLedger({
      renameFile: async (from) => {
        temporaryObserved = from;
        expect(existsSync(from)).toBe(true);
        expect(statSync(from).mode & 0o777).toBe(0o600);
        throw new Error("injected rename failure");
      },
    });

    await expect(ledger.beginAttempt(seed, now)).rejects.toMatchObject({
      code: "retry-ledger-storage",
    });
    expect(temporaryObserved).not.toBe("");
    expect(readdirSync(join(root, "reports")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
}

export function registerRetryLedgerRetentionCases(): void {
  it("同 root 写操作串行；同 key 的 daily/weekly 记录互不覆盖", async () => {
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let renameCalls = 0;
    let activeRenames = 0;
    let maxActiveRenames = 0;
    const renameFile = async (from: string, to: string): Promise<void> => {
      renameCalls += 1;
      activeRenames += 1;
      maxActiveRenames = Math.max(maxActiveRenames, activeRenames);
      if (renameCalls === 1) {
        firstEntered();
        await gate;
      }
      try {
        await rename(from, to);
      } finally {
        activeRenames -= 1;
      }
    };
    const dailyLedger = newLedger({ renameFile });
    const weeklyLedger = newLedger({ renameFile });

    const daily = dailyLedger.beginAttempt(seed, now);
    await entered;
    const weekly = weeklyLedger.beginAttempt(
      { ...seed, period: "weekly", startDay: "2026-09-23", endDay: "2026-09-23" },
      now,
    );
    await Promise.resolve();
    expect(renameCalls).toBe(1);
    releaseFirst();
    await Promise.all([daily, weekly]);

    expect(maxActiveRenames).toBe(1);
    expect((await dailyLedger.list()).map(({ period, key }) => ({ period, key }))).toEqual([
      { period: "daily", key: "2026-09-23" },
      { period: "weekly", key: "2026-09-23" },
    ]);
  });

  it("terminal 每 period 只留最新 key；reconcile 按 lastRun/index 精确清理", async () => {
    const ledger = newLedger();
    await makeTerminal(
      ledger,
      { ...seed, key: "2026-09-21", startDay: "2026-09-21", endDay: "2026-09-21" },
      now,
    );
    const newestDaily = await makeTerminal(
      ledger,
      { ...seed, key: "2026-09-23", startDay: "2026-09-23", endDay: "2026-09-23" },
      now,
    );
    const weeklyTerminal = await makeTerminal(
      ledger,
      {
        ...seed,
        period: "weekly",
        key: "2026-09-17",
        startDay: "2026-09-17",
        endDay: "2026-09-23",
      },
      now,
    );

    expect((await ledger.list()).map(({ period, key }) => ({ period, key }))).toEqual([
      { period: "daily", key: newestDaily.key },
      { period: "weekly", key: weeklyTerminal.key },
    ]);

    const indexed: Array<{ period: "daily" | "weekly" | "monthly"; key: string }> = [
      { period: "weekly", key: weeklyTerminal.key },
    ];
    const removed = await ledger.reconcile({ daily: "2026-09-23" }, indexed);
    expect(removed).toEqual([newestDaily, weeklyTerminal]);
    expect(await ledger.list()).toEqual([]);
  });

  it("ledger 只持久化稳定 reason，不落 raw message", async () => {
    const ledger = newLedger();
    const claim = await ledger.beginAttempt(seed, now);
    if (claim === null) throw new Error("expected claim");
    const failureWithRawMessage = {
      code: "persist-failed",
      kind: "storage" as const,
      message: "secret path /tmp/token and raw provider response",
    };
    await ledger.recordFailure(claim, failureWithRawMessage, now);

    const text = readFileSync(retryLedgerFile(root), "utf8");
    expect(text).toContain('"code":"persist-failed"');
    expect(text).toContain('"kind":"storage"');
    expect(text).not.toContain("secret path");
    expect(text).not.toContain("token");
  });
}

export function registerRetryLedgerSuite(): void {
  describe("retry-ledger：durable JSON / CAS / recover / per-root 串行", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      now = Date.UTC(2026, 8, 24, 0, 0, 0);
      vi.setSystemTime(now);
      savedDshHome = process.env.DSH_HOME;
      home = mkdtempSync(join(tmpdir(), "u-retry-ledger-home-"));
      process.env.DSH_HOME = home;
      root = join(home, "dsh-provider-usage");
      cycleSequence = 0;
    });
    afterEach(() => {
      if (savedDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = savedDshHome;
      rmSync(home, { recursive: true, force: true });
      vi.useRealTimers();
    });
    registerRetryLedgerObservationCases();
    registerRetryLedgerTransitionCases();
    registerRetryLedgerRecoveryCases();
    registerRetryLedgerStorageCases();
    registerRetryLedgerRetentionCases();
  });
}
