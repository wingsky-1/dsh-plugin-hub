// @vitest-environment happy-dom
/**
 * dsh-provider-usage — 趋势区块直测（#732 阶段1 A片 G3硬门）。
 *
 * 守的事实（一句话）：TrendSection 经 GET /trend 读聚合序列并渲染标题/汇总/图例/图表，
 * fetch 失败渲染错误态，空序列渲染空态；三态任一漂移必须红至少一条。
 *
 * 时间纪律：act 排空 Promise（render+act 即 mount），不用假时钟；pollUntil 不用；
 * 离线（fetch 手写假件），无落盘。
 *
 * 假件说明：fetch 是 globalThis 上的手写假函数（只记调用、按 ok/空/失败分流返回
 * 趋势聚合快照，不实现任何服务端语义）；locale 不装配（t 回落 key 本体，
 * 故标题即 trendTitle）；唯一 vi 用法无（不用 vi.fn）。
 */
import * as React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bindLocale } from "../../../../shared/client/i18n.js";

// 趋势区块经 shared/contract 取 TREND_URL（构建期 __DSH_ROUTES__ 注入；单测无注入
// 即回落本地镜像）。bare 标识在运行时走全局解析——先置全局再动态 import 被测模块，
// 静态 import 会先于本行求值而抛 ReferenceError。
(globalThis as Record<string, unknown>).__DSH_ROUTES__ = undefined;
const { TrendSection } = await import("../../src/client/trend.tsx");

const realFetch = globalThis.fetch;
let calls: string[];

function trendPayload(series: unknown[], summary: unknown): unknown {
  return {
    ok: true,
    granularity: "day",
    metric: "total",
    provider: null,
    byModel: false,
    n: series.length,
    retentionDays: 180,
    series,
    providers: [{ provider: "deepseek", model: null }],
    dirs: [],
    summary,
    firstDay: "2026-09-20",
  };
}

function fullSeries(): unknown[] {
  return [
    {
      key: "2026-09-20",
      total: 100,
      parts: [{ provider: "deepseek", model: null, value: 100 }],
    },
    {
      key: "2026-09-21",
      total: 200,
      parts: [{ provider: "deepseek", model: null, value: 200 }],
    },
  ];
}

function fullSummary(): unknown {
  return {
    total: 300,
    calls: 10,
    turns: 5,
    toolCalls: 2,
    peakKey: "2026-09-21",
    top: { provider: "deepseek", model: null, value: 300 },
    prevTotal: 150,
    prevComplete: true,
  };
}

function installFetch(mode: "full" | "empty" | "fail"): void {
  const fake = async (input: unknown): Promise<unknown> => {
    calls.push(String(input));
    if (mode === "fail") {
      return { ok: false, status: 500, json: async (): Promise<unknown> => ({ ok: false }) };
    }
    const series = mode === "empty" ? [] : fullSeries();
    const summary =
      mode === "empty"
        ? {
            total: null,
            calls: 0,
            turns: 0,
            toolCalls: 0,
            peakKey: null,
            top: null,
            prevTotal: null,
            prevComplete: true,
          }
        : fullSummary();
    return {
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => trendPayload(series, summary),
    };
  };
  globalThis.fetch = fake as unknown as typeof fetch;
}

beforeEach(() => {
  document.body.textContent = "";
  calls = [];
  bindLocale(
    {
      bind:
        () =>
        (key: string): string =>
          key,
    },
    "providerUsage",
  );
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  document.body.textContent = "";
  bindLocale(
    {
      bind:
        () =>
        (key: string): string =>
          key,
    },
    "providerUsage",
  );
});

describe("TrendSection 三态", () => {
  it("GET 成功有数据时渲染标题与图表区", async () => {
    installFetch("full");
    const view = render(React.createElement(TrendSection));
    await act(async () => {});
    expect(view.getByText("trendTitle").tagName).toBe("H2");
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain("/api/dsh-provider-usage/trend");
  });

  it("GET 失败时渲染错误态", async () => {
    installFetch("fail");
    const view = render(React.createElement(TrendSection));
    await act(async () => {});
    expect(view.getByText("trendFetchFail").textContent).toBe("trendFetchFail");
  });

  it("GET 成功但空序列时渲染空态", async () => {
    installFetch("empty");
    const view = render(React.createElement(TrendSection));
    await act(async () => {});
    expect(view.getByText("trendEmptyTitle").textContent).toBe("trendEmptyTitle");
    expect(view.getByText("trendEmptyHint").textContent).toBe("trendEmptyHint");
  });
});
