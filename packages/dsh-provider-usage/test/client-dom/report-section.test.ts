// @vitest-environment happy-dom
/**
 * dsh-provider-usage — 报告 reasoning effort 垂直切片（#1010）。
 *
 * 时间纪律：普通用例只用 act 排空 Promise 链；poll 用例显式伪造 setTimeout/clearTimeout/Date
 * （Date 覆盖 src/client/report.tsx 的 new Date(nextRetryAt) 投影，避免真时钟混进断言），绝不真实 sleep。
 * 离线纪律：fetch 与 Response 均为手写窄假件；不实现服务端 capability 判定。
 * locale 回落为 key 本体，断言只观察用户可见标签、wire URL 与保存 JSON。
 */
import * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindLocale } from "../../../../shared/client/i18n.js";

(globalThis as Record<string, unknown>).__DSH_ROUTES__ = undefined;
const { ReportSection } = await import("../../src/client/report.tsx");

interface FetchCall {
  url: string;
  method: string;
  body: string | null;
}

interface SelectedModelFixture {
  id: string;
  name?: string;
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>;
    defaultEffort?: string;
  };
  capabilityError?: true;
}

interface HttpFixture {
  body: unknown;
  status?: number;
}

interface GenerateFixture {
  post: HttpFixture;
  statuses: HttpFixture[];
}

const BASE_CONFIG = {
  daily: { enabled: true, time: "08:00" },
  weekly: { enabled: false, time: "09:00", weekStartsOn: 1 },
  monthly: { enabled: false, time: "10:00", dayOfMonth: 1 },
  provider: "vendor-a",
  model: "",
  promptTemplate: "legacy",
  prompts: {
    daily: "daily prompt",
    weekly: "weekly prompt",
    monthly: "monthly prompt",
  },
  sanitizePaths: true,
  push: { enabled: false },
  directories: [],
};

const DEFAULT_SELECTED_MODEL: SelectedModelFixture = {
  id: "vendor-b::model",
  name: "Vendor B Model",
  reasoning: {
    efforts: [
      {
        id: "vendor::balanced",
        name: "Balanced",
        description: "Balanced description from DSH",
      },
      {
        id: "vendor::deep",
        name: "Deep",
        description: "Deep description from DSH",
      },
    ],
    defaultEffort: "vendor::deep",
  },
};

const COMPLETE_META = {
  period: "daily",
  key: "2026-03-12",
  startDay: "2026-03-12",
  endDay: "2026-03-12",
  provider: "vendor-a",
  model: "vendor-a::model",
  generatedAt: 1_800_000_000_000,
  durationMs: 900,
  ok: true,
} as const;

const COMPLETE_RETRY = {
  attempts: 2,
  maxAttempts: 5,
  nextRetryAt: null,
  terminal: false,
  terminalReason: null,
  usage: {
    inputTokens: 120,
    outputTokens: 30,
    reasoningTokens: 18,
    totalTokens: 168,
    cacheReadTokens: 40,
    cacheWriteTokens: 7,
    durationMs: 2_750,
  },
} as const;

const NULL_RETRY = {
  attempts: 0,
  maxAttempts: 5,
  nextRetryAt: null,
  terminal: false,
  terminalReason: null,
  usage: {
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    durationMs: null,
  },
} as const;

const realFetch = globalThis.fetch;
let calls: FetchCall[];

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async (): Promise<unknown> => body,
  } as unknown as Response;
}

function configWith(
  patch: Partial<typeof BASE_CONFIG> & { reasoningEffort?: string },
): typeof BASE_CONFIG & { reasoningEffort?: string } {
  return { ...BASE_CONFIG, ...patch };
}

function installFetch(options: {
  config: typeof BASE_CONFIG & { reasoningEffort?: string };
  modelsByProvider: Record<string, Array<{ id: string; name?: string }>>;
  selectedModels?: Record<string, SelectedModelFixture>;
  generate?: GenerateFixture;
}): void {
  let statusIndex = 0;
  const fake = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body });

    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname.endsWith("/report-config") && method === "GET") {
      return response({
        ok: true,
        config: options.config,
        providers: [
          { id: "vendor-a", name: "Vendor A" },
          { id: "vendor-b", name: "Vendor B" },
        ],
        dirs: [],
        promptDefaults: BASE_CONFIG.prompts,
      });
    }
    if (parsed.pathname.endsWith("/report-models")) {
      const provider = parsed.searchParams.get("provider") ?? "";
      const model = parsed.searchParams.get("model");
      const models = options.modelsByProvider[provider] ?? [];
      if (model === null) return response({ ok: true, models });
      const selectedModel = options.selectedModels?.[model];
      return response({
        ok: true,
        models,
        ...(selectedModel === undefined ? {} : { selectedModel }),
      });
    }
    if (parsed.pathname.endsWith("/report-config") && method === "POST") {
      const posted = JSON.parse(body ?? "{}") as Record<string, unknown>;
      return response({ ok: true, config: posted });
    }
    if (parsed.pathname.endsWith("/reports/generate") && method === "POST") {
      const fixture = options.generate?.post;
      if (fixture === undefined) return response({ ok: false, error: "unexpected-generate" }, 500);
      return response(fixture.body, fixture.status ?? 202);
    }
    if (parsed.pathname.endsWith("/reports/generate/status") && method === "GET") {
      const fixture = options.generate?.statuses[statusIndex];
      statusIndex += 1;
      if (fixture === undefined) return response({ ok: false, error: "unexpected-status" }, 500);
      return response(fixture.body, fixture.status ?? 200);
    }
    return response({ ok: false, error: "unexpected-request" }, 500);
  };
  globalThis.fetch = fake as unknown as typeof fetch;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

function renderReport(
  onGeneratedRow: (meta: unknown) => void = (): void => {},
): ReturnType<typeof render> {
  return render(
    React.createElement(ReportSection, {
      onGeneratedRow,
    }),
  );
}

async function selectExactModel(): Promise<ReturnType<typeof render>> {
  const view = renderReport();
  await settle();
  calls = [];

  fireEvent.change(view.getByLabelText("reportProvider"), { target: { value: "vendor-b" } });
  await settle();

  fireEvent.change(view.getByLabelText("reportModel"), {
    target: { value: "vendor-b::model" },
  });
  await settle();
  return view;
}

/** 全部 POST 请求体（按发生顺序）：调用点自行钉死条数与内容，不在此处做存在性兜底。 */
function postBodies(): Record<string, unknown>[] {
  return calls
    .filter((call) => call.method === "POST")
    .map((call) => JSON.parse(call.body ?? "{}") as Record<string, unknown>);
}

/** 未保存标记的宿主 class 名列表：空数组即「无脏」，非空即逐个点名是头还是段。 */
function dirtyScopes(view: ReturnType<typeof render>): string[] {
  return Array.from(view.container.querySelectorAll(".dou-reportDirty")).map(
    (node) => node.parentElement?.className ?? "",
  );
}

async function openGenerateSection(view: ReturnType<typeof render>): Promise<void> {
  fireEvent.click(view.getByRole("button", { name: /reportSectionGenerate/ }));
  await settle();
}

async function runPoll(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await settle();
}

beforeEach(() => {
  document.body.textContent = "";
  calls = [];
  bindLocale(
    {
      bind:
        () =>
        (key: string, params?: Record<string, unknown>): string => {
          if (params === undefined) return key;
          const details = Object.entries(params)
            .map(([name, value]) => `${name}=${String(value)}`)
            .join(",");
          return `${key}:${details}`;
        },
    },
    "providerUsage",
  );
});

afterEach(() => {
  vi.useRealTimers();
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

describe("ReportSection：provider → exact model → reasoning effort", () => {
  it("列表请求不带 model，选中模型后只请求该 exact id 并保持 DSH 展示顺序", async () => {
    installFetch({
      config: BASE_CONFIG,
      modelsByProvider: {
        "vendor-a": [{ id: "vendor-a::model", name: "A Model" }],
        "vendor-b": [
          { id: "vendor-b::model", name: "B Model" },
          { id: "vendor-b::other", name: "Other Model" },
        ],
      },
      selectedModels: { "vendor-b::model": DEFAULT_SELECTED_MODEL },
    });

    const view = await selectExactModel();
    const providerListCalls = calls.filter((call) => call.url.includes("/report-models"));
    expect(providerListCalls).toHaveLength(2);
    expect(providerListCalls[0]!.url).toBe(
      "/api/dsh-provider-usage/report-models?provider=vendor-b",
    );
    const exactUrl = new URL(providerListCalls[1]!.url, "http://localhost");
    expect(exactUrl.searchParams.get("provider")).toBe("vendor-b");
    expect(exactUrl.searchParams.get("model")).toBe("vendor-b::model");

    const effort = view.getByLabelText("reportReasoningEffort") as HTMLSelectElement;
    const options = Array.from(effort.options);
    expect(effort.disabled).toBe(false);
    expect(effort.value).toBe("");
    // 展示顺序与文案整体比对：DSH 顺序保持、默认档位标记只落在 defaultEffort 上。
    expect(
      options.map((option) => [option.value, option.textContent, option.getAttribute("title")]),
    ).toEqual([
      ["", "reportReasoningUnset", null],
      ["vendor::balanced", "Balanced (vendor::balanced)", "Balanced description from DSH"],
      ["vendor::deep", "Deep (vendor::deep) · reportReasoningDefault", "Deep description from DSH"],
    ]);
    // 选中模型名进 title：档位描述取自 DSH 而非客户端自造。
    expect(effort.getAttribute("title")).toBe("Vendor B Model");
  });

  it("选择后进入 dirty/save，清除后保存整份配置但省略 reasoningEffort", async () => {
    installFetch({
      config: BASE_CONFIG,
      modelsByProvider: {
        "vendor-a": [{ id: "vendor-a::model" }],
        "vendor-b": [{ id: "vendor-b::model", name: "B Model" }],
      },
      selectedModels: { "vendor-b::model": DEFAULT_SELECTED_MODEL },
    });
    const view = await selectExactModel();

    fireEvent.change(view.getByLabelText("reportReasoningEffort"), {
      target: { value: "vendor::deep" },
    });
    // 脏标记恰好两处：全局头 + routing 段头（探针实测），不多不少。
    expect(dirtyScopes(view)).toEqual(["dou-reportHead", "dou-reportSectionHead"]);
    fireEvent.click(view.getByRole("button", { name: "reportSave" }));
    await settle();
    expect(dirtyScopes(view)).toEqual([]);
    expect(postBodies()).toEqual([
      {
        ...BASE_CONFIG,
        provider: "vendor-b",
        model: "vendor-b::model",
        reasoningEffort: "vendor::deep",
      },
    ]);

    fireEvent.change(view.getByLabelText("reportReasoningEffort"), { target: { value: "" } });
    expect(dirtyScopes(view)).toEqual(["dou-reportHead", "dou-reportSectionHead"]);
    fireEvent.click(view.getByRole("button", { name: "reportSave" }));
    await settle();
    expect(dirtyScopes(view)).toEqual([]);
    // 两次保存各发一次 POST；第二条整体比对即覆盖「省略 reasoningEffort」。
    const saved = postBodies();
    expect(saved).toHaveLength(2);
    expect(saved[1]).toEqual({
      ...BASE_CONFIG,
      provider: "vendor-b",
      model: "vendor-b::model",
    });
    expect(Object.hasOwn(saved[1]!, "reasoningEffort")).toBe(false);
  });

  it("保留 stale effort 且提示，用户清除后不静默丢失其他配置", async () => {
    installFetch({
      config: configWith({ model: "vendor-a::model", reasoningEffort: "vendor::retired" }),
      modelsByProvider: {
        "vendor-a": [{ id: "vendor-a::model", name: "A Model" }],
      },
      selectedModels: {
        "vendor-a::model": {
          id: "vendor-a::model",
          reasoning: {
            efforts: [{ id: "vendor::current", name: "Current" }],
            defaultEffort: "vendor::current",
          },
        },
      },
    });
    const view = renderReport();
    await settle();
    calls = [];

    const effort = view.getByLabelText("reportReasoningEffort") as HTMLSelectElement;
    expect(effort.value).toBe("vendor::retired");
    expect(Array.from(effort.options).map((option) => option.value)).toEqual([
      "",
      "vendor::retired",
      "vendor::current",
    ]);
    // 提示是独立 hint，且「不可用 / 能力错误」两条提示互斥（report.tsx:504-509 各自条件渲染）。
    expect(view.getAllByText("reportReasoningStale")).toHaveLength(1);
    expect(view.getByText("reportReasoningStale").className).toBe("dou-reportHint");
    expect(view.queryAllByText("reportReasoningUnavailable")).toHaveLength(0);
    expect(view.queryAllByText("reportReasoningCapabilityError")).toHaveLength(0);

    fireEvent.change(effort, { target: { value: "" } });
    expect((view.getByLabelText("reportReasoningEffort") as HTMLSelectElement).value).toBe("");
    expect(view.queryAllByText("reportReasoningStale")).toHaveLength(0);
    fireEvent.click(view.getByRole("button", { name: "reportSave" }));
    await settle();
    const saved = postBodies();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({ ...configWith({ model: "vendor-a::model" }) });
    expect(Object.hasOwn(saved[0]!, "reasoningEffort")).toBe(false);
  });

  it.each([
    {
      label: "reasoning 缺失",
      selectedModel: { id: "vendor-a::model" },
      hint: "reportReasoningUnavailable",
      otherHint: "reportReasoningCapabilityError",
    },
    {
      label: "capabilityError",
      selectedModel: { id: "vendor-a::model", capabilityError: true },
      hint: "reportReasoningCapabilityError",
      otherHint: "reportReasoningUnavailable",
    },
  ] as const)("$label 显示独立安全提示且不伪造档位", async ({ selectedModel, hint, otherHint }) => {
    installFetch({
      config: configWith({ model: "vendor-a::model" }),
      modelsByProvider: {
        "vendor-a": [{ id: "vendor-a::model", name: "A Model" }],
      },
      selectedModels: { "vendor-a::model": selectedModel },
    });
    const view = renderReport();
    await settle();

    const effort = view.getByLabelText("reportReasoningEffort") as HTMLSelectElement;
    expect(view.getAllByText(hint)).toHaveLength(1);
    expect(view.getByText(hint).className).toBe("dou-reportHint");
    expect(view.queryAllByText(otherHint)).toHaveLength(0);
    expect(view.queryAllByText("reportReasoningStale")).toHaveLength(0);
    expect(effort.disabled).toBe(true);
    // 只剩「未设置」一项：不伪造档位，也不把未知值回显成可选项。
    expect(Array.from(effort.options).map((option) => [option.value, option.textContent])).toEqual([
      ["", "reportReasoningUnset"],
    ]);
  });
});

describe("ReportSection：#1010 A8 retry 状态与累计成本", () => {
  it("poll 投影显示 outer attempt、六类累计 token 与 duration", async () => {
    installFetch({
      config: BASE_CONFIG,
      modelsByProvider: {},
      generate: {
        post: { body: { ok: true, taskId: "task-1010" } },
        statuses: [
          { body: { ok: true, status: "running", retry: COMPLETE_RETRY } },
          { body: { ok: true, status: "done", meta: COMPLETE_META } },
        ],
      },
    });
    // toFake 只列真实用到的那几个：poll 退避 sleep 用 setTimeout（report.tsx:48），
    // Date 供 nextRetryAt 的 new Date(...).toISOString() 投影（report.tsx:832）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const view = renderReport();
    await settle();
    await openGenerateSection(view);

    fireEvent.click(view.getByRole("button", { name: "reportGenerate" }));
    await settle();
    // busy 期：按钮换文案且 disabled，force 勾选框同时禁用。
    const busy = view.getByRole("button", { name: "reportGenerating" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(view.queryAllByRole("button", { name: "reportGenerate" })).toHaveLength(0);
    expect((view.getByLabelText("reportForceRegen") as HTMLInputElement).disabled).toBe(true);

    await runPoll(1_000);
    // 逐个子节点比对：条数、顺序、文本同时锁死（探针实测为 8 个 span）。
    const status = view.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(Array.from(status.children, (node) => node.textContent)).toEqual([
      "reportRetryRunning",
      "reportRetryAttempt:attempt=3,maxAttempts=5",
      "reportRetryInputTokens:value=120",
      "reportRetryOutputTokens:value=30",
      "reportRetryReasoningTokens:value=18",
      "reportRetryTotalTokens:value=168",
      "reportRetryCacheTokens:read=40,write=7",
      "reportRetryDuration:value=2750",
    ]);
    // running 态不渲染 nextRetryAt / terminal 两行（否则会被上面数组的长度挡住）。
    expect(status.querySelectorAll(".dou-reportGenNotice")).toHaveLength(1);

    await runPoll(2_000);
    expect(view.queryByRole("status")).toBeNull();
    // done 后回到可再次触发的空闲态。
    const idle = view.getByRole("button", { name: "reportGenerate" }) as HTMLButtonElement;
    expect(idle.disabled).toBe(false);
  });

  it.each([
    {
      label: "busy",
      response: {
        body: {
          ok: false,
          status: "busy",
          reason: "retry-in-progress",
          retry: { ...COMPLETE_RETRY, nextRetryAt: null },
        },
        status: 409,
      },
      rows: [
        "reportRetryBusy",
        "reportRetryAttempt:attempt=3,maxAttempts=5",
        "reportRetryInputTokens:value=120",
        "reportRetryOutputTokens:value=30",
        "reportRetryReasoningTokens:value=18",
        "reportRetryTotalTokens:value=168",
        "reportRetryCacheTokens:read=40,write=7",
        "reportRetryDuration:value=2750",
      ],
    },
    {
      label: "deferred",
      response: {
        body: {
          ok: false,
          status: "deferred",
          reason: "retry-in-progress",
          retry: { ...COMPLETE_RETRY, nextRetryAt: 1_800_000_000_000 },
        },
        status: 409,
      },
      // nextRetryAt 非空时多渲染一行（report.tsx:831-834），故此处 9 行。
      rows: [
        "reportRetryDeferred",
        "reportRetryAttempt:attempt=3,maxAttempts=5",
        "reportRetryNextAt:at=2027-01-15T08:00:00.000Z",
        "reportRetryInputTokens:value=120",
        "reportRetryOutputTokens:value=30",
        "reportRetryReasoningTokens:value=18",
        "reportRetryTotalTokens:value=168",
        "reportRetryCacheTokens:read=40,write=7",
        "reportRetryDuration:value=2750",
      ],
    },
    {
      label: "terminal",
      response: {
        body: {
          ok: false,
          status: "terminal",
          reason: "empty-output",
          retry: {
            ...NULL_RETRY,
            attempts: 5,
            terminal: true,
            terminalReason: { code: "empty-output", kind: "empty-output" },
          },
        },
        status: 409,
      },
      // 成本全 null → 每项显示「未知」，且 terminal 不再渲染 nextRetryAt。
      rows: [
        "reportRetryTerminal:code=empty-output,kind=empty-output",
        "reportRetryAttempt:attempt=6,maxAttempts=5",
        "reportRetryInputTokens:value=reportRetryUnknown",
        "reportRetryOutputTokens:value=reportRetryUnknown",
        "reportRetryReasoningTokens:value=reportRetryUnknown",
        "reportRetryTotalTokens:value=reportRetryUnknown",
        "reportRetryCacheTokens:read=reportRetryUnknown,write=reportRetryUnknown",
        "reportRetryDuration:value=reportRetryUnknown",
      ],
    },
  ] as const)("$label 状态可理解且 null 成本显示未知", async ({ response, rows }) => {
    installFetch({
      config: BASE_CONFIG,
      modelsByProvider: {},
      generate: { post: response, statuses: [] },
    });
    const view = renderReport();
    await settle();
    await openGenerateSection(view);
    fireEvent.click(view.getByRole("button", { name: "reportGenerate" }));
    await settle();

    // 409 重试占用也要发一次 generate POST：请求语义不因状态分支而变。
    expect(postBodies()).toEqual([{ period: "daily", force: false }]);
    const status = view.getByRole("status");
    expect(Array.from(status.children, (node) => node.textContent)).toEqual(rows);
  });

  it("旧 poll body 无 retry 时保持旧 UI，并继续完成或失败", async () => {
    const generated: unknown[] = [];
    installFetch({
      config: BASE_CONFIG,
      modelsByProvider: {},
      generate: {
        post: { body: { ok: true, taskId: "task-old" } },
        statuses: [
          { body: { ok: true, status: "queued" } },
          { body: { ok: true, status: "done", meta: COMPLETE_META } },
        ],
      },
    });
    // 同上：只伪造 poll 退避与日期投影真正用到的三个 API。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const view = renderReport((meta) => generated.push(meta));
    await settle();
    await openGenerateSection(view);
    fireEvent.click(view.getByRole("button", { name: "reportGenerate" }));
    await settle();

    await runPoll(1_000);
    // 无 retry 字段 → 不出 status 区，但仍在轮询（按钮保持 busy）。
    expect(view.queryByRole("status")).toBeNull();
    const busy = view.getByRole("button", { name: "reportGenerating" }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await runPoll(2_000);
    expect(generated).toEqual([COMPLETE_META]);
    expect(view.queryByRole("status")).toBeNull();
    expect(
      (view.getByRole("button", { name: "reportGenerate" }) as HTMLButtonElement).disabled,
    ).toBe(false);

    cleanup();
    installFetch({
      config: BASE_CONFIG,
      modelsByProvider: {},
      generate: {
        post: { body: { ok: true, taskId: "task-old-failed" } },
        statuses: [{ body: { ok: true, status: "failed", error: "legacy failure" } }],
      },
    });
    const failedView = renderReport();
    await settle();
    await openGenerateSection(failedView);
    fireEvent.click(failedView.getByRole("button", { name: "reportGenerate" }));
    await settle();
    await runPoll(1_000);
    // 失败文案落在 error 槽，且不与 retry status 区混用同一个节点类型。
    const failure = failedView.getByText("reportGenerateFail:msg=legacy failure");
    expect(failure.className).toBe("dou-reportGenError");
    expect(failedView.queryAllByText("reportGenerateFail:msg=legacy failure")).toHaveLength(1);
    expect(failedView.queryByRole("status")).toBeNull();
    expect(
      (failedView.getByRole("button", { name: "reportGenerate" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("manual force、reused 与 HTTP error 维持既有文案和请求语义", async () => {
    const generated: unknown[] = [];
    installFetch({
      config: BASE_CONFIG,
      modelsByProvider: {},
      generate: {
        post: { body: { ok: true, meta: COMPLETE_META, reused: true } },
        statuses: [],
      },
    });
    const reusedView = renderReport((meta) => generated.push(meta));
    await settle();
    await openGenerateSection(reusedView);
    fireEvent.click(reusedView.getByLabelText("reportForceRegen"));
    fireEvent.click(reusedView.getByRole("button", { name: "reportGenerate" }));
    await settle();
    expect(postBodies()).toEqual([{ period: "daily", force: true }]);
    // 命中缓存：出 notice，且不新增报告行（onGeneratedRow 不被调用）。
    expect(reusedView.getAllByText("reportReused")).toHaveLength(1);
    expect(reusedView.getByText("reportReused").className).toBe("dou-reportGenNotice");
    expect(reusedView.queryByRole("status")).toBeNull();
    expect(generated).toEqual([]);

    cleanup();
    installFetch({
      config: BASE_CONFIG,
      modelsByProvider: {},
      generate: {
        post: { body: { ok: false, error: "legacy unavailable" }, status: 503 },
        statuses: [],
      },
    });
    const errorView = renderReport();
    await settle();
    await openGenerateSection(errorView);
    fireEvent.click(errorView.getByRole("button", { name: "reportGenerate" }));
    await settle();
    // 503 直接带出 HTTP error 文案，并伴随「可重试」提示（report.tsx:934-936）。
    const failure = errorView.getByText("reportGenerateFail:msg=legacy unavailable");
    expect(failure.className).toBe("dou-reportGenError");
    expect(errorView.getAllByText("reportRetryHint")).toHaveLength(1);
    expect(errorView.queryByRole("status")).toBeNull();
    expect(
      (errorView.getByRole("button", { name: "reportGenerate" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});
