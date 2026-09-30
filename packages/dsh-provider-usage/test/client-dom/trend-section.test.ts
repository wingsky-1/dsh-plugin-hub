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

describe("A1/A2/A3 交互重做：口径三值恒显 + 图例键盘可达 + 窄容器降级", () => {
  /** 用 role/aria 查询（冻结契约①），不按 className 选元素（契约③DOM 结构非契约）。 */
  function caliberGroup(view: { container: HTMLElement }): HTMLElement {
    const hit = view.container.querySelector('[role="group"][aria-label="trendCaliberLabel"]');
    if (hit === null) throw new Error("统计口径分段器缺失");
    return hit as HTMLElement;
  }

  it("统计口径三值恒显（永不条件渲染）", async () => {
    installFetch("full");
    const view = render(React.createElement(TrendSection));
    await act(async () => {});
    const items = caliberGroup(view).querySelectorAll("button");
    expect(items.length).toBe(3);
    const labels = [...items].map((b) => b.textContent ?? "");
    expect(labels[0]).toContain("trendCaliberDir");
    expect(labels[1]).toContain("trendCaliberProvider");
    expect(labels[2]).toContain("trendCaliberModel");
  });

  it("模型档 disabled + 就地说明需宿主支持（不许画一个点了就空的格子）", async () => {
    installFetch("full");
    const view = render(React.createElement(TrendSection));
    await act(async () => {});
    const items = caliberGroup(view).querySelectorAll("button");
    expect((items[0] as HTMLButtonElement).disabled).toBe(false);
    expect((items[1] as HTMLButtonElement).disabled).toBe(false);
    expect((items[2] as HTMLButtonElement).disabled).toBe(true);
    expect(view.container.textContent).toContain("trendCaliberModelNote");
  });

  it("口径分段器用 role=group + button[aria-pressed]，不用 tablist/navigation", async () => {
    installFetch("full");
    const view = render(React.createElement(TrendSection));
    await act(async () => {});
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    expect(view.container.querySelector('[role="navigation"]')).toBeNull();
    const active = caliberGroup(view).querySelectorAll('button[aria-pressed="true"]');
    expect(active.length).toBe(1);
  });

  it("对象选择器恒在（不再是按口径条件挂载的下拉）", async () => {
    installFetch("full");
    const view = render(React.createElement(TrendSection));
    await act(async () => {});
    expect(view.container.textContent).toContain("trendObjectLabel");
    expect(view.container.textContent).toContain("trendObjectAllDir");
  });

  it("图例是真 button（Tab 可进出、Space 可切换），非 span role=switch", async () => {
    installFetch("full");
    const view = render(React.createElement(TrendSection));
    await act(async () => {});
    const legend = view.container.querySelector('[role="group"][aria-label="trendLegendLabel"]');
    if (legend === null) throw new Error("图例缺失");
    const sw = legend.querySelectorAll("button[aria-pressed]");
    expect(sw.length).toBeGreaterThan(0);
    // 旧实现是 span[role=switch]（键盘不可达）——负向护栏
    expect(legend.querySelectorAll('span[role="switch"]').length).toBe(0);
  });

  it("图例点击切换 aria-pressed（显隐不发请求）", async () => {
    installFetch("full");
    const view = render(React.createElement(TrendSection));
    await act(async () => {});
    const before = calls.length;
    const legend = view.container.querySelector('[role="group"][aria-label="trendLegendLabel"]');
    const first = legend?.querySelector('button[aria-pressed="true"]') as HTMLButtonElement;
    expect(first).toBeTruthy();
    await act(async () => {
      first.click();
    });
    const legend2 = view.container.querySelector('[role="group"][aria-label="trendLegendLabel"]');
    const after = legend2?.querySelector('button[aria-pressed="false"]') as HTMLButtonElement;
    expect(after).toBeTruthy();
    // 显隐是纯前端行为：不发新请求
    expect(calls.length).toBe(before);
  });

  it("主数值 + 元信息行取代 5 张卡（元信息含按粒度命名的均值）", async () => {
    installFetch("full");
    const view = render(React.createElement(TrendSection));
    await act(async () => {});
    const text = view.container.textContent ?? "";
    expect(text).toContain("trendMetricTotal");
    expect(text).toContain("trendMetaCoverage");
    expect(text).toContain("trendMetaToolCalls");
    // 均值按粒度命名（日粒度 → 日均），不再恒写 trendCardAvg 的「日均」
    expect(text).toContain("trendMetaAvgLabel");
  });
});
