/**
 * report-routes 组合根：D11二 配置服务窄面消费 + 任务队列 + 执行器（handler 行为面）。
 *
 * 由原入口 composition-root.test.ts 在原顺序同步注册；父 suite/title/each/expect/fixture 与
 * cache 生命周期、hook/await 时点完全保持（拆分为注册调用，零行为变更）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleReportConfig,
  handleReportModels,
  handleReports,
  handleReportDetail,
  handleReportGenerate,
  handleReportStatus,
} from "../../../src/server/report-routes/interface.ts";
import type {
  ReportRoutesConfigPort,
  ReportRoutesQueuePort,
} from "../../../src/server/report-routes/deps.ts";
import type { ReportRoutesContext } from "../../../src/server/report-routes/interface.ts";
import * as reportRoutesDepsNs from "../../../src/server/report-routes/deps.ts";
import {
  ReportConfigService,
  normalizeReportConfig,
} from "../../../src/server/config/interface.ts";
import { readLastRun, updateLastRun } from "../../../src/server/schedule/interface.ts";
import {
  createRetryLedger,
  createReportStateCoordinator,
  previousClosedWindow,
  ReportTaskQueue,
} from "../../../src/server/schedule/interface.ts";
import { callStatus, isolatedDir } from "./report-routes-composition-fixtures.ts";
import {
  DONE_TASK_ID,
  FAILED_TASK_ID,
  UNKNOWN_TASK_ID,
  fakeReq,
  routeCapability,
  stubReportCtx,
  type AnyHandler,
} from "./report-routes-composition-fixtures.ts";
import {
  registerReportRoutesSourceContractCases,
  type ReportRoutesSourceContractSources,
} from "./report-routes-composition-source-contract.ts";

/** D11二 仍须原入口读出的 src 文本（判据 = 实现内无执行器符号）。 */
export type ReportRoutesHandlerSources = ReportRoutesSourceContractSources;

export function registerReportRoutesHandlerCases(src: ReportRoutesHandlerSources): void {
  describe("D11二 配置服务窄面消费 + 任务队列 + 执行器", () => {
    registerReportRoutesContractCases();
    registerReportRoutesConfigCases();
    registerReportRoutesModelDiscoveryCases();
    registerReportRoutesModelCapabilityCases();
    registerReportRoutesHistoryCases();
    registerReportRoutesGenerationCases();
    registerReportRoutesRetryStateCases();
    registerReportRoutesOldCycleForceCases();
    registerReportRoutesForceCases();
    registerReportRoutesForceFailureCases();
    registerReportRoutesSourceContractCases(src);
  });
}

function registerReportRoutesContractCases(): void {
  it("deps.ts 纯类型面：运行时零出口", () => {
    expect(Object.keys(reportRoutesDepsNs)).toEqual([]);
  });

  it("真实例可赋值窄口（Pick 收窄断裂即红，tsc 编译面）", () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const svc = new ReportConfigService({ root, initial: normalizeReportConfig({}) });
    const queue = new ReportTaskQueue({ executor: async () => ({}) });
    const cfgPort: ReportRoutesConfigPort = svc;
    const queuePort: ReportRoutesQueuePort = queue;
    expect(typeof cfgPort.get).toBe("function");
    expect(typeof queuePort.submit).toBe("function");
  });
}

function registerReportRoutesConfigCases(): void {
  it("窄面桩跑通配置读写（内存权威 + 串行写，确权即红）", async () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const { ctx, cfg } = stubReportCtx(root);
    const got = await callStatus(handleReportConfig as AnyHandler, fakeReq({ method: "GET" }), ctx);
    expect(got.code).toBe(200);
    expect((got.body as { ok?: boolean }).ok).toBe(true);
    expect((got.body as { dirs?: unknown }).dirs).toEqual([{ dir: "d" }]);
    const posted = await callStatus(
      handleReportConfig as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({}) }),
      ctx,
    );
    expect(posted.code).toBe(200);
    expect((cfg._current() as { daily: { time: string } }).daily.time).toBe("08:00");
  });

  it.each([
    { label: "非 string", value: 7 },
    { label: "空串", value: "" },
  ])("POST reasoningEffort 为$label时显式 400 且不改配置", async ({ value }) => {
    const root = isolatedDir("dou-reportroutes-reasoning-effort-");
    const { ctx, cfg } = stubReportCtx(root);
    const before = cfg._current();

    const posted = await callStatus(
      handleReportConfig as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ reasoningEffort: value }) }),
      ctx,
    );

    expect(posted.code).toBe(400);
    expect((posted.body as { error?: string }).error).toBe("invalid-reasoning-effort");
    expect(cfg._current()).toBe(before);
  });

  it("首次启用翻转落盘lastRun（changed接线，断线即红）", async () => {
    // #768 B1b：changed=true→updateLastRun 接线覆盖（翻转 daily 关闭→启用，lastRun 落盘非空）。
    const root = isolatedDir("dou-reportroutesD11-flip-");
    const { ctx } = stubReportCtx(root);
    const posted = await callStatus(
      handleReportConfig as AnyHandler,
      fakeReq({
        method: "POST",
        body: JSON.stringify({ daily: { enabled: true, time: "08:00" } }),
      }),
      ctx,
    );
    expect(posted.code).toBe(200);
    const lastRun = await readLastRun(root);
    expect(typeof lastRun.daily).toBe("string");
    expect((lastRun.daily as string).length).toBeGreaterThan(0);
  });

  it("目录候选异常不连坐配置本身（降级空数组，误拦即红）", async () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const { ctx } = stubReportCtx(root, { throwingDirs: true });
    const got = await callStatus(handleReportConfig as AnyHandler, fakeReq({ method: "GET" }), ctx);
    expect(got.code).toBe(200);
    expect((got.body as { dirs?: unknown }).dirs).toEqual([]);
  });
}

function registerReportRoutesModelDiscoveryCases(): void {
  it("窄面桩跑通模型发现（未知 provider 与超时外形态，误判即红）", async () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const { ctx } = stubReportCtx(root);
    const known = await callStatus(
      handleReportModels as AnyHandler,
      fakeReq({ method: "GET", url: "/?provider=stub-p" }),
      ctx,
    );
    expect(known.code).toBe(200);
    expect((known.body as { ok?: boolean }).ok).toBe(true);
    expect((known.body as { models?: Array<{ id: string }> }).models).toEqual([{ id: "m1" }]);
    const unknown = await callStatus(
      handleReportModels as AnyHandler,
      fakeReq({ method: "GET", url: "/?provider=ghost" }),
      ctx,
    );
    expect((unknown.body as { reason?: string }).reason).toBe("unknown-provider");
  });
}

function registerReportRoutesModelCapabilityCases(): void {
  describe("report-models：exact model capability wire", () => {
    registerReportRoutesModelCatalogCases();
    registerReportRoutesModelCapabilityFailureCases();
  });
}

function registerReportRoutesModelCatalogCases(): void {
  it("无 model 参数保持 models[] 且不调用 resolver", async () => {
    const root = isolatedDir("dou-reportroutes-model-capability-");
    const { ctx, llmSeen } = stubReportCtx(root);

    const response = await callStatus(
      handleReportModels as AnyHandler,
      fakeReq({ method: "GET", url: "/?provider=stub-p" }),
      ctx,
    );

    expect(response.code).toBe(200);
    expect(response.body).toEqual({ ok: true, models: [{ id: "m1" }] });
    expect(llmSeen.resolveCalls).toEqual([]);
  });

  it("多模型目录只查 exact model 一次并透传 efforts 顺序、name、description、default", async () => {
    const root = isolatedDir("dou-reportroutes-model-capability-");
    const { ctx, llmSeen } = stubReportCtx(root, {
      models: [
        { id: "m1", name: "Catalog M1" },
        { id: "m2", name: "Catalog M2" },
        { id: "m3", name: "Catalog M3" },
      ],
      capability: routeCapability,
    });

    const response = await callStatus(
      handleReportModels as AnyHandler,
      fakeReq({ method: "GET", url: "/?provider=stub-p&model=m2" }),
      ctx,
    );

    expect(response.code).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      models: [
        { id: "m1", name: "Catalog M1" },
        { id: "m2", name: "Catalog M2" },
        { id: "m3", name: "Catalog M3" },
      ],
      selectedModel: {
        id: "m2",
        name: "M2 capability",
        reasoning: {
          efforts: [
            { id: "vendor::deep", name: "Deep", description: "深度思考" },
            { id: "vendor::balanced", name: "Balanced" },
          ],
          defaultEffort: "vendor::balanced",
        },
      },
    });
    expect(llmSeen.resolveCalls).toEqual([
      { provider: "stub-p", model: "m2", signal: expect.any(AbortSignal) },
    ]);
  });

  it("exact model 不在列表时返回 unknown-model 且不调用 resolver", async () => {
    const root = isolatedDir("dou-reportroutes-model-capability-");
    const { ctx, llmSeen } = stubReportCtx(root);

    const response = await callStatus(
      handleReportModels as AnyHandler,
      fakeReq({ method: "GET", url: "/?provider=stub-p&model=missing" }),
      ctx,
    );

    expect(response.code).toBe(200);
    expect(response.body).toEqual({ ok: false, reason: "unknown-model" });
    expect(llmSeen.resolveCalls).toEqual([]);
  });

  it("命中模型但 capability resolver 失败时保留 models[] 并标记 capabilityError", async () => {
    const root = isolatedDir("dou-reportroutes-model-capability-");
    const { ctx, llmSeen } = stubReportCtx(root, {
      models: [{ id: "m1", name: "Catalog M1" }],
      capabilityError: "capability unavailable",
    });

    const response = await callStatus(
      handleReportModels as AnyHandler,
      fakeReq({ method: "GET", url: "/?provider=stub-p&model=m1" }),
      ctx,
    );

    expect(response.code).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      models: [{ id: "m1", name: "Catalog M1" }],
      selectedModel: { id: "m1", capabilityError: true },
    });
    expect(llmSeen.resolveCalls).toEqual([
      { provider: "stub-p", model: "m1", signal: expect.any(AbortSignal) },
    ]);
  });
}

function registerReportRoutesModelCapabilityFailureCases(): void {
  it("never-settling resolver 超时返回 capabilityError 并尽力 abort 底层", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const root = isolatedDir("dou-reportroutes-model-capability-timeout-");
      const { ctx, llmSeen } = stubReportCtx(root, {
        models: [{ id: "m1" }, { id: "m2" }],
        capabilityNever: true,
      });
      const pending = callStatus(
        handleReportModels as AnyHandler,
        fakeReq({ method: "GET", url: "/?provider=stub-p&model=m2" }),
        ctx,
      );

      await vi.advanceTimersByTimeAsync(5000);
      const response = await pending;

      expect(response.code).toBe(200);
      expect(response.body).toEqual({
        ok: true,
        models: [{ id: "m1" }, { id: "m2" }],
        selectedModel: { id: "m2", capabilityError: true },
      });
      expect(llmSeen.resolveCalls).toHaveLength(1);
      expect(llmSeen.resolveCalls[0]!.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("模型列表异常只返回稳定 code，不泄露 resolver 原始文案", async () => {
    const root = isolatedDir("dou-reportroutes-model-discover-safe-error-");
    const raw = "key=sk-private path=/private/report.json";
    const { ctx } = stubReportCtx(root, { modelsError: raw });

    const response = await callStatus(
      handleReportModels as AnyHandler,
      fakeReq({ method: "GET", url: "/?provider=stub-p" }),
      ctx,
    );

    expect(response.code).toBe(200);
    expect(response.body).toEqual({ ok: false, reason: "discover-failed" });
    expect(JSON.stringify(response.body)).not.toContain(raw);
  });
}

function registerReportRoutesHistoryCases(): void {
  it("窄面桩跑通历史索引与详情围栏（空索引 200，键非法 400，缺件 404）", async () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const { ctx } = stubReportCtx(root);
    const list = await callStatus(handleReports as AnyHandler, fakeReq({ method: "GET" }), ctx);
    expect(list.code).toBe(200);
    expect((list.body as { reports?: unknown[] }).reports).toEqual([]);
    const badPeriod = await callStatus(
      handleReportDetail as AnyHandler,
      fakeReq({ method: "GET", url: "/?period=bogus&key=x" }),
      ctx,
    );
    expect(badPeriod.code).toBe(400);
    const badKey = await callStatus(
      handleReportDetail as AnyHandler,
      fakeReq({ method: "GET", url: "/?period=daily&key=not-a-date" }),
      ctx,
    );
    expect((badKey.body as { error?: string }).error).toBe("invalid-key");
    const missing = await callStatus(
      handleReportDetail as AnyHandler,
      fakeReq({ method: "GET", url: "/?period=daily&key=2026-09-18" }),
      ctx,
    );
    expect(missing.code).toBe(404);
  });
}

function registerReportRoutesGenerationCases(): void {
  it("窄面桩跑通手动生成与状态轮询（非法 400，入队 202，done/failed/未知分支）", async () => {
    const root = isolatedDir("dou-reportroutesD11-");
    const { ctx } = stubReportCtx(root);
    const bad = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "bogus" }) }),
      ctx,
    );
    expect(bad.code).toBe(400);
    const queued = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "daily", force: true }) }),
      ctx,
    );
    expect(queued.code).toBe(202);
    expect((queued.body as { taskId?: string }).taskId).toBe(DONE_TASK_ID);
    const done = await callStatus(
      handleReportStatus as AnyHandler,
      fakeReq({ method: "GET", url: "/?taskId=" + DONE_TASK_ID }),
      ctx,
    );
    expect(done.code).toBe(200);
    expect((done.body as { status?: string }).status).toBe("done");
    const failed = await callStatus(
      handleReportStatus as AnyHandler,
      fakeReq({ method: "GET", url: "/?taskId=" + FAILED_TASK_ID }),
      ctx,
    );
    expect((failed.body as { error?: string }).error).toBe("boom");
    const unknown = await callStatus(
      handleReportStatus as AnyHandler,
      fakeReq({ method: "GET", url: "/?taskId=" + UNKNOWN_TASK_ID }),
      ctx,
    );
    expect(unknown.code).toBe(404);
    const illegal = await callStatus(
      handleReportStatus as AnyHandler,
      fakeReq({ method: "GET", url: "/?taskId=not-a-uuid" }),
      ctx,
    );
    expect(illegal.code).toBe(404);
  });
}

function registerReportRoutesRetryStateCases(): void {
  it("非 force 遇 waiting/terminal ledger 时明确 deferred/terminal 且不入队", async () => {
    const root = isolatedDir("dou-reportroutes-retry-state-");
    const { ctx } = stubReportCtx(root);
    const ledger = createRetryLedger(root, {
      createCycleId: (() => {
        let n = 0;
        return () => `route-cycle-${(n += 1)}`;
      })(),
    });
    const state = createReportStateCoordinator({ root, ledger });
    const due = previousClosedWindow("daily", ctx.reportCfgService.get(), Date.now());
    const claim = await state.beginAttempt({
      ...due,
      route: { provider: "stub-p", model: "m1" },
    });
    if (claim === null) throw new Error("expected claim");
    await state.recordFailure(claim, { code: "transient", kind: "transient" });
    const waiting = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "daily" }) }),
      { ...ctx, retryState: state },
    );
    expect(waiting.code).toBe(409);
    expect((waiting.body as { status?: string }).status).toBe("deferred");
    await state.beginForce({
      ...due,
      route: { provider: "stub-p", model: "m1" },
    });
    const terminalEntry = await state.get(due.period, due.key);
    if (terminalEntry === undefined) throw new Error("expected terminal ledger");
    const terminalClaim = await state.beginAttempt({
      ...due,
      cycleId: terminalEntry.cycleId,
      route: terminalEntry.route,
    });
    if (terminalClaim === null) throw new Error("expected terminal claim");
    await state.recordFailure(terminalClaim, { code: "permanent", kind: "permanent" });
    const terminal = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "daily" }) }),
      { ...ctx, retryState: state },
    );
    expect(terminal.code).toBe(409);
    expect((terminal.body as { status?: string }).status).toBe("terminal");
  });
}

function registerReportRoutesOldCycleForceCases(): void {
  it.each(["waiting", "in-flight"] as const)(
    "旧 cycle index 遇到 force %s 时 non-force 仅复用，不清新 ledger/lastRun",
    async (phase) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = Date.UTC(2026, 8, 24, 12, 0, 0);
      vi.setSystemTime(now);
      const root = isolatedDir(`dou-reportroutes-old-index-${phase}-`);
      const { ctx } = stubReportCtx(root);
      const due = previousClosedWindow("daily", ctx.reportCfgService.get(), now);
      const ledger = createRetryLedger(root, {
        createCycleId: (() => {
          let sequence = 0;
          return () => `route-cycle-${(sequence += 1)}`;
        })(),
      });
      const state = createReportStateCoordinator({ root, ledger, now: () => now });
      const oldClaim = await state.beginAttempt(
        {
          ...due,
          route: { provider: "stub-p", model: "m1" },
        },
        now - 1,
      );
      if (oldClaim === null) throw new Error("expected old claim");
      const oldMeta = {
        period: due.period,
        key: due.key,
        startDay: due.startDay,
        endDay: due.endDay,
        provider: "stub-p",
        model: "m1",
        generatedAt: now - 1,
        durationMs: 1,
        ok: true,
        cycleId: oldClaim.cycleId,
      };
      mkdirSync(join(root, "reports"), { recursive: true });
      writeFileSync(join(root, "reports", "index.jsonl"), `${JSON.stringify(oldMeta)}\n`);
      const forced = await state.beginForce(
        {
          ...due,
          route: { provider: "stub-p", model: "m1" },
        },
        now,
      );
      if (phase === "in-flight") {
        const claim = await state.beginAttempt(
          {
            ...due,
            cycleId: forced.cycleId,
            route: forced.route,
          },
          now,
        );
        if (claim === null) throw new Error("expected in-flight force claim");
      }
      const beforeLastRun = { daily: "2000-01-01" };
      await updateLastRun(root, () => beforeLastRun);

      try {
        const response = await callStatus(
          handleReportGenerate as AnyHandler,
          fakeReq({ method: "POST", body: JSON.stringify({ period: "daily", force: false }) }),
          { ...ctx, retryState: state },
        );

        expect(response.code).toBe(200);
        expect(response.body).toMatchObject({ ok: true, reused: true, meta: oldMeta });
        expect(await state.get(due.period, due.key)).toMatchObject({
          cycleId: forced.cycleId,
          phase,
          terminal: false,
        });
        expect(await readLastRun(root)).toEqual(beforeLastRun);
      } finally {
        vi.useRealTimers();
      }
    },
  );
}

function registerReportRoutesForceCases(): void {
  it("force 走 submitForce；status 透出稳定 retry 状态", async () => {
    const root = isolatedDir("dou-reportroutes-force-");
    const { ctx } = stubReportCtx(root);
    const taskId = "44444444-4444-4444-8444-444444444444";
    let submitted = 0;
    const queue: ReportRoutesQueuePort & {
      submitForce?: (input: {
        period: "daily";
        key: string;
        startDay: string;
        endDay: string;
        force: true;
      }) => Promise<{ taskId: string; existing: boolean }>;
    } = {
      submit: () => ({ taskId: DONE_TASK_ID, existing: false }),
      submitForce: async () => {
        submitted += 1;
        return { taskId, existing: false };
      },
      get: (id: string) =>
        id === taskId
          ? {
              id,
              period: "daily",
              key: "2026-09-18",
              startDay: "2026-09-18",
              endDay: "2026-09-18",
              force: true,
              status: "failed",
              createdAt: 1,
              updatedAt: 2,
              error: "storage",
            }
          : undefined,
    };
    const retryState = {
      get: async () => ({
        period: "daily" as const,
        key: "2026-09-18",
        startDay: "2026-09-18",
        endDay: "2026-09-18",
        route: { provider: "stub-p", model: "m1" },
        attempts: 2,
        maxAttempts: 5 as const,
        nextRetryAt: 1234,
        terminal: false,
        reason: null,
        cycleId: "c1",
        phase: "waiting" as const,
        attemptObservations: [],
        usage: {
          inputTokens: 11,
          outputTokens: null,
          reasoningTokens: 3,
          totalTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          durationMs: 42,
        },
      }),
    } as unknown as ReportRoutesContext["retryState"];
    const withState = { ...ctx, reportQueue: queue, retryState };
    const response = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "daily", force: true }) }),
      withState,
    );
    expect(response.code).toBe(202);
    expect(submitted).toBe(1);
    const status = await callStatus(
      handleReportStatus as AnyHandler,
      fakeReq({ method: "GET", url: `/?taskId=${taskId}` }),
      withState,
    );
    expect(status.code).toBe(200);
    expect((status.body as { error?: string; retry?: unknown }).error).toBe("storage");
    expect(
      (status.body as { retry?: { attempts?: number; usage?: unknown } }).retry?.attempts,
    ).toBe(2);
    expect((status.body as { retry?: { usage?: unknown } }).retry?.usage).toEqual({
      inputTokens: 11,
      outputTokens: null,
      reasoningTokens: 3,
      totalTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      durationMs: 42,
    });
  });
}

function registerReportRoutesForceFailureCases(): void {
  it("force prepare/提交失败返回稳定 code，不泄露原始错误", async () => {
    const root = isolatedDir("dou-reportroutes-force-error-");
    const { ctx } = stubReportCtx(root);
    const queue: ReportRoutesQueuePort & {
      submitForce?: () => Promise<{ taskId: string; existing: boolean }>;
    } = {
      submit: () => ({ taskId: DONE_TASK_ID, existing: false }),
      submitForce: async () => {
        throw new Error("secret path=/private/report.json key=sk-live");
      },
      get: () => undefined,
    };
    const response = await callStatus(
      handleReportGenerate as AnyHandler,
      fakeReq({ method: "POST", body: JSON.stringify({ period: "daily", force: true }) }),
      { ...ctx, reportQueue: queue },
    );
    expect(response.code).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("secret path");
    expect(JSON.stringify(response.body)).not.toContain("sk-live");
  });
}
