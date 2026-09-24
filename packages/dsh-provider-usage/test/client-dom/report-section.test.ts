// @vitest-environment happy-dom
/**
 * dsh-provider-usage — 报告 reasoning effort 垂直切片（#1010）。
 *
 * 时间纪律：只用 act 排空 Promise 链，不用假时钟或真实 sleep。
 * 离线纪律：fetch 与 Response 均为手写窄假件；不实现服务端 capability 判定。
 * locale 回落为 key 本体，断言只观察用户可见标签、wire URL 与保存 JSON。
 */
import * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
}): void {
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
    return response({ ok: false, error: "unexpected-request" }, 500);
  };
  globalThis.fetch = fake as unknown as typeof fetch;
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

function renderReport(): ReturnType<typeof render> {
  return render(
    React.createElement(ReportSection, {
      onGeneratedRow: (): void => {},
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
