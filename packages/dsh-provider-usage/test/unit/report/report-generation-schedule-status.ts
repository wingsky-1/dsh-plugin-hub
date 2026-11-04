/**
 * dsh-provider-usage report generation suites by natural responsibility.
 *
 * Assertion bodies, suite titles, tables, hooks, and fixtures are moved from the
 * single report runner. The runner imports these modules in original suite order.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  ReportTaskQueue,
  __lastRunChainForTests,
  callHandler,
  handleReportStatus,
  join,
  mkdtempSync,
  pollUntil,
  readFileSync,
  readLastRun,
  tmpdir,
  updateLastRun,
  type IncomingMessage,
  type ReportRoutesContext,
  type ServerResponse,
} from "./report-generation-support.ts";

type StatusState = {
  taskDefined: boolean;
  taskReused: boolean | undefined;
  payloadStatus: string;
  payloadReused: boolean | undefined;
  payload2Status: string;
  payload2Reused: boolean | undefined;
};

describe("#629 P2 updateLastRun：并发风暴（10 并发各写各字段）", () => {
  let keptCount: number;
  let schema: unknown;

  beforeAll(async () => {
    const root3 = mkdtempSync(join(tmpdir(), "dou-report-lrstorm-"));
    const writes = Array.from({ length: 10 }, (_, i) =>
      updateLastRun(root3, (cur) => ({ ...cur, [`f${i}`]: `v${i}` })),
    );
    await Promise.all(writes);
    await __lastRunChainForTests(root3);
    // readLastRun 只透出 daily/weekly/monthly 白名单键（schema:1 兼容过滤），
    // f0..f9 断言须读原始落盘文件观察
    const final = JSON.parse(readFileSync(join(root3, "reports", "last-run.json"), "utf8"));
    keptCount = Array.from({ length: 10 }, (_, i) => final[`f${i}`]).filter(
      (v) => v !== undefined,
    ).length;
    schema = final.schema;
  });

  it("并发风暴 10 字段全保留", () => {
    expect(keptCount).toBe(10);
  });

  it("临界区写沿用 schema 版本标记", () => {
    expect(schema).toBe(2);
  });
});

describe("#629 P2 updateLastRun：patch 抛错不阻塞链上后续", () => {
  it("patch 抛错向调用方透传", async () => {
    const root5 = mkdtempSync(join(tmpdir(), "dou-report-lrerr-"));
    await expect(
      updateLastRun(root5, () => {
        throw new Error("boom-patch");
      }),
    ).rejects.toThrow(/boom-patch/);
  });

  it("抛错的更新不落盘且不阻塞后续更新", async () => {
    const root5 = mkdtempSync(join(tmpdir(), "dou-report-lrerr-"));
    await updateLastRun(root5, () => {
      throw new Error("boom-patch");
    }).catch(() => {});
    await updateLastRun(root5, (cur) => ({ ...cur, daily: "2026-09-04" }));
    expect((await readLastRun(root5)).daily).toBe("2026-09-04");
  });
});

function registerReusedTaskCases(state: StatusState): void {
  it("复用任务到达 done", () => {
    expect(state.taskDefined).toBeTruthy();
  });

  it("executor reused:true → task.reused=true", () => {
    expect(state.taskReused).toBe(true);
  });

  it("status done", () => {
    expect(state.payloadStatus).toBe("done");
  });
}

function registerStatusPayloadCases(state: StatusState): void {
  it("status 响应透传 reused（客户端轮询提示数据源）", () => {
    expect(state.payloadReused).toBe(true);
  });

  it("非复用任务 status done", () => {
    expect(state.payload2Status).toBe("done");
  });

  it("非复用任务不携带 reused（新生成语义不变）", () => {
    expect(state.payload2Reused).toBeUndefined();
  });
}

describe("#629 P2 executor 复用 → 队列记录 + status 响应透传 reused", () => {
  const state = {} as StatusState;

  beforeAll(async () => {
    // executor 幂等短路（返回 reused:true）→ task.done 且 task.reused=true →
    // handleReportStatus 响应携带 reused（客户端轮询路径「已复用」提示的数据源）
    const queue = new ReportTaskQueue({
      executor: async () => ({
        meta: {
          period: "daily",
          key: "2026-09-05",
          startDay: "2026-09-05",
          endDay: "2026-09-05",
          generatedAt: 1,
          ok: true,
          provider: "",
          model: "",
          durationMs: 0,
        },
        reused: true,
      }),
      warn: () => {},
    });
    const sub = queue.submit({
      period: "daily",
      key: "2026-09-05",
      startDay: "2026-09-05",
      endDay: "2026-09-05",
    });
    const task = await pollUntil(
      () => {
        const t = queue.get(sub.taskId);
        return t?.status === "done" ? t : undefined;
      },
      5000,
      2,
    );
    state.taskDefined = task !== undefined;
    state.taskReused = task?.reused;
    // status 路由响应透传 reused（直调 handler：包 {handler} 适配 helpers.callHandler
    // 的三参形态，补 context 实参——handleReportStatus 仅消费 reportQueue 字段）
    const payload = await callHandler<{ status: string; reused?: boolean }>(
      {
        handler: (req, res) =>
          handleReportStatus(
            req as IncomingMessage,
            res as ServerResponse,
            {
              reportQueue: queue,
            } as unknown as ReportRoutesContext,
          ),
      },
      {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
        method: "GET",
        url: `/api/dsh-provider-usage/reports/generate/status?taskId=${sub.taskId}`,
      },
    );
    state.payloadStatus = payload.status;
    state.payloadReused = payload.reused;

    // 对照：非复用任务（reused 缺省）不携带 reused 字段
    const queue2 = new ReportTaskQueue({
      executor: async () => ({
        meta: {
          period: "daily",
          key: "2026-09-06",
          startDay: "2026-09-06",
          endDay: "2026-09-06",
          generatedAt: 2,
          ok: true,
          provider: "",
          model: "",
          durationMs: 0,
        },
      }),
      warn: () => {},
    });
    const sub2 = queue2.submit({
      period: "daily",
      key: "2026-09-06",
      startDay: "2026-09-06",
      endDay: "2026-09-06",
    });
    await pollUntil(() => queue2.get(sub2.taskId)?.status === "done", 5000, 2);
    const payload2 = await callHandler<{ status: string; reused?: boolean }>(
      {
        handler: (req, res) =>
          handleReportStatus(
            req as IncomingMessage,
            res as ServerResponse,
            {
              reportQueue: queue2,
            } as unknown as ReportRoutesContext,
          ),
      },
      {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
        method: "GET",
        url: `/api/dsh-provider-usage/reports/generate/status?taskId=${sub2.taskId}`,
      },
    );
    state.payload2Status = payload2.status;
    state.payload2Reused = payload2.reused;
  });

  registerReusedTaskCases(state);
  registerStatusPayloadCases(state);
});
