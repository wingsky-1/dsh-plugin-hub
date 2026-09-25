// @vitest-environment happy-dom
/**
 * dsh-provider-usage — 报告 reasoning effort 垂直切片（#1010）。
 *
 * 时间纪律：普通用例只用 act 排空 Promise 链；poll 用例显式伪造 setTimeout/clearTimeout，绝不真实 sleep。
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

function lastPostBody(): Record<string, unknown> {
  const posts = calls.filter((call) => call.method === "POST");
  expect(posts.length).toBeGreaterThan(0);
  return JSON.parse(posts[posts.length - 1]!.body ?? "{}") as Record<string, unknown>;
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
    expect(options.map((option) => option.value)).toEqual(["", "vendor::balanced", "vendor::deep"]);
    expect(options[1]!.textContent).toContain("Balanced");
    expect(options[1]!.getAttribute("title")).toBe("Balanced description from DSH");
    expect(options[1]!.textContent).not.toContain("reportReasoningDefault");
    expect(options[2]!.textContent).toContain("Deep");
    expect(options[2]!.getAttribute("title")).toBe("Deep description from DSH");
    expect(options[2]!.textContent).toContain("reportReasoningDefault");
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
    expect(view.getAllByText("reportUnsaved").length).toBeGreaterThan(0);
    fireEvent.click(view.getByRole("button", { name: "reportSave" }));
    await settle();
    expect(lastPostBody()).toEqual({
      ...BASE_CONFIG,
      provider: "vendor-b",
      model: "vendor-b::model",
      reasoningEffort: "vendor::deep",
    });

    fireEvent.change(view.getByLabelText("reportReasoningEffort"), { target: { value: "" } });
    expect(view.getAllByText("reportUnsaved").length).toBeGreaterThan(0);
    fireEvent.click(view.getByRole("button", { name: "reportSave" }));
    await settle();
    const cleared = lastPostBody();
    expect(cleared).toEqual({
      ...BASE_CONFIG,
      provider: "vendor-b",
      model: "vendor-b::model",
    });
    expect(Object.hasOwn(cleared, "reasoningEffort")).toBe(false);
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
    expect(view.getByText("reportReasoningStale")).toBeTruthy();

    fireEvent.change(effort, { target: { value: "" } });
    fireEvent.click(view.getByRole("button", { name: "reportSave" }));
    await settle();
    const body = lastPostBody();
    expect(body.provider).toBe("vendor-a");
    expect(body.model).toBe("vendor-a::model");
    expect(Object.hasOwn(body, "reasoningEffort")).toBe(false);
  });

  it.each([
    {
      label: "reasoning 缺失",
      selectedModel: { id: "vendor-a::model" },
      hint: "reportReasoningUnavailable",
    },
    {
      label: "capabilityError",
      selectedModel: { id: "vendor-a::model", capabilityError: true },
      hint: "reportReasoningCapabilityError",
    },
  ] as const)("$label 显示独立安全提示且不伪造档位", async ({ selectedModel, hint }) => {
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
    expect(view.getByText(hint)).toBeTruthy();
    expect(effort.disabled).toBe(true);
    expect(Array.from(effort.options).map((option) => option.value)).toEqual([""]);
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const view = renderReport();
    await settle();
    await openGenerateSection(view);

    fireEvent.click(view.getByRole("button", { name: "reportGenerate" }));
    await settle();
    expect(view.getByRole("button", { name: "reportGenerating" })).toBeTruthy();

    await runPoll(1_000);
    const status = view.getByRole("status");
    expect(status.textContent).toContain("reportRetryRunning");
    expect(status.textContent).toContain("reportRetryAttempt:attempt=3,maxAttempts=5");
    expect(status.textContent).toContain("reportRetryInputTokens:value=120");
    expect(status.textContent).toContain("reportRetryOutputTokens:value=30");
    expect(status.textContent).toContain("reportRetryReasoningTokens:value=18");
    expect(status.textContent).toContain("reportRetryTotalTokens:value=168");
    expect(status.textContent).toContain("reportRetryCacheTokens:read=40,write=7");
    expect(status.textContent).toContain("reportRetryDuration:value=2750");
    expect(status.textContent).not.toContain("reportRetryNextAt");
    expect(status.textContent).not.toContain("reportRetryTerminal");

    await runPoll(2_000);
    expect(view.queryByRole("status")).toBeNull();
  });

  it("null 成本显示未知，busy / deferred / terminal 状态可理解", async () => {
    const cases = [
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
        expected: ["reportRetryBusy", "reportRetryInputTokens:value=120"],
        absent: ["reportRetryNextAt", "reportRetryTerminal"],
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
        expected: ["reportRetryDeferred", "reportRetryNextAt:at=2027-01-15T08:00:00.000Z"],
        absent: ["reportRetryBusy", "reportRetryTerminal"],
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
        expected: [
          "reportRetryTerminal:code=empty-output,kind=empty-output",
          "reportRetryInputTokens:value=reportRetryUnknown",
          "reportRetryOutputTokens:value=reportRetryUnknown",
          "reportRetryReasoningTokens:value=reportRetryUnknown",
          "reportRetryTotalTokens:value=reportRetryUnknown",
          "reportRetryCacheTokens:read=reportRetryUnknown,write=reportRetryUnknown",
          "reportRetryDuration:value=reportRetryUnknown",
        ],
        absent: ["reportRetryNextAt", "reportRetryBusy", "reportRetryDeferred"],
      },
    ] as const;

    for (const testCase of cases) {
      installFetch({
        config: BASE_CONFIG,
        modelsByProvider: {},
        generate: { post: testCase.response, statuses: [] },
      });
      const view = renderReport();
      await settle();
      await openGenerateSection(view);
      fireEvent.click(view.getByRole("button", { name: "reportGenerate" }));
      await settle();

      const status = view.getByRole("status");
      for (const text of testCase.expected) expect(status.textContent).toContain(text);
      for (const text of testCase.absent) expect(status.textContent).not.toContain(text);
      cleanup();
    }
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const view = renderReport((meta) => generated.push(meta));
    await settle();
    await openGenerateSection(view);
    fireEvent.click(view.getByRole("button", { name: "reportGenerate" }));
    await settle();

    await runPoll(1_000);
    expect(view.queryByRole("status")).toBeNull();
    expect(view.getByRole("button", { name: "reportGenerating" })).toBeTruthy();
    await runPoll(2_000);
    expect(generated).toEqual([COMPLETE_META]);

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
    expect(failedView.getByText("reportGenerateFail:msg=legacy failure")).toBeTruthy();
    expect(failedView.queryByRole("status")).toBeNull();
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
    expect(lastPostBody()).toEqual({ period: "daily", force: true });
    expect(reusedView.getByText("reportReused")).toBeTruthy();
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
    expect(errorView.getByText("reportGenerateFail:msg=legacy unavailable")).toBeTruthy();
    expect(errorView.queryByRole("status")).toBeNull();
  });
});
