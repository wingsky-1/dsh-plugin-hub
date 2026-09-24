// @vitest-environment happy-dom
/**
 * dsh-mcp-manager — 设置卡直测（P3-b/B6）。
 *
 * 守的事实（一句话）：SettingsCard 的 page 经 GET /config 读扁平 UI 5 键并经
 * POST /config 写回；summary 不发请求，page 根节点不是旧 settings list item。
 *
 * 时间纪律：act 排空 Promise（render+act 即 page mount），
 * 不用假时钟（2400ms 清提示不断）；pollUntil 不用；离线（fetch 手写假件），无落盘。
 *
 * 假件说明：fetch 是 globalThis 上的手写假函数（只记调用、按方法分流返回
 * GET 快照与 POST 回执，不实现任何服务端语义）；locale 不装配（t 回落 key 本体，
 * 故字段与按钮文案回落 key 本体）；唯一 vi 用法是 deferred 的手动 resolve（非 vi.fn 替身）。
 */
import * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsCard } from "../../src/client/settings/settings-card.tsx";
import { bindLocale } from "../../../../shared/client/i18n.js";

type FetchCall = { url: string; method: string; body: string | undefined };

let calls: FetchCall[];
let getPayload: unknown;
let postReply: () => Promise<{ ok: boolean; body: unknown }>;
let postDeferred:
  | {
      promise: Promise<{ ok: boolean; body: unknown }>;
      resolve: (v: { ok: boolean; body: unknown }) => void;
    }
  | undefined;
const realFetch = globalThis.fetch;

function okWrap(body: unknown): { ok: boolean; body: unknown } {
  return { ok: true, body };
}

function installFetch(): void {
  const fake = async (
    input: unknown,
    init?: { method?: string; body?: unknown },
  ): Promise<unknown> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body !== undefined ? String(init.body) : undefined;
    calls.push({ url, method, body });
    if (method === "POST") {
      if (postDeferred !== undefined) {
        const p = postDeferred.promise;
        postDeferred = undefined;
        const v = await p;
        return {
          ok: v.ok,
          status: v.ok ? 200 : 500,
          json: async (): Promise<unknown> => v.body,
        };
      }
      const v = await postReply();
      return {
        ok: v.ok,
        status: v.ok ? 200 : 500,
        json: async (): Promise<unknown> => v.body,
      };
    }
    return {
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => getPayload,
    };
  };
  globalThis.fetch = fake as unknown as typeof fetch;
}

function baseCfg(): Record<string, unknown> {
  return { position: "top-right", offsetX: 8, offsetY: 8, blankY: 40, zIndexBase: 3000 };
}

function card(view: "summary" | "page" = "page", form?: unknown): React.ReactElement {
  const props: { view: "summary" | "page"; form?: unknown } =
    form === undefined ? { view } : { view, form };
  return React.createElement(SettingsCard, props);
}

/** row page 直接渲染完整表单；GET 排空后字段即可操作。 */
async function mountPage(): Promise<ReturnType<typeof render>> {
  const view = render(card("page"));
  await act(async () => {});
  return view;
}

function posts(): FetchCall[] {
  return calls.filter((c) => c.method === "POST");
}

function lastPostBody(): Record<string, unknown> {
  const p = posts();
  if (p.length === 0) throw new Error("expected at least one POST");
  return JSON.parse(String(p[p.length - 1].body)) as Record<string, unknown>;
}

beforeEach(() => {
  document.body.textContent = "";
  calls = [];
  postDeferred = undefined;
  getPayload = baseCfg();
  postReply = async () => okWrap({ ok: true });
  installFetch();
  bindLocale(
    {
      bind:
        () =>
        (key: string): string =>
          key,
    },
    "mcpManager",
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
    "mcpManager",
  );
});

describe("SettingsCard row owner 视图", () => {
  it("summary 可在 form 缺省时渲染，且不读取 config/health 或返回 row page DOM", async () => {
    const view = render(card("summary"));
    await act(async () => {});

    expect(calls).toEqual([]);
    expect(view.container.firstElementChild).toBe(null);
  });

  it("page 读取 config 并返回非 li 的 row page 根节点", async () => {
    const view = render(card("page"));
    await act(async () => {});

    expect(view.container.firstElementChild?.tagName).toBe("DIV");
    expect(view.container.querySelector(".dm-set-card")?.tagName).toBe("DIV");
    expect(view.container.querySelector("select#dm-set-position")).not.toBe(null);
    expect(view.container.querySelectorAll("input.dm-set-input")).toHaveLength(4);
    expect(view.container.querySelector(".dm-set-save")).not.toBe(null);
    expect(view.container.querySelector("li")).toBe(null);
    expect(view.container.querySelector(".dm-set-name")).toBe(null);
    expect(view.container.querySelector(".dm-set-description")).toBe(null);

    const position = view.container.querySelector("#dm-set-position") as HTMLSelectElement;
    const offsetX = view.container.querySelectorAll<HTMLInputElement>("input.dm-set-input")[0];
    expect(position.value).toBe("top-right");
    expect(offsetX.value).toBe("8");
    fireEvent.change(position, { target: { value: "bottom-left" } });
    fireEvent.change(offsetX, { target: { value: "20" } });
    expect(position.value).toBe("bottom-left");
    expect(offsetX.value).toBe("20");
    fireEvent.click(view.getByRole("button", { name: "save" }));
    await act(async () => {});
    expect(lastPostBody()).toEqual({
      position: "bottom-left",
      offsetX: 20,
      offsetY: 8,
      blankY: 40,
      zIndexBase: 3000,
    });
    expect(calls.filter((call) => call.method === "GET")).toEqual([
      { url: "/api/dsh-mcp/config", method: "GET", body: undefined },
    ]);
    expect(calls.filter((call) => call.url.includes("/health"))).toEqual([]);
  });
});

describe("SettingsCard 两态", () => {
  it("GET pending 时为加载态（L25 cfg null 分支），零 POST", async () => {
    let resolveGet!: (v: unknown) => void;
    const gate = new Promise<unknown>((done) => {
      resolveGet = done;
    });
    getPayload = gate;
    // 让 GET 挂起：重装一个等待 gate 的假件
    const pendingCalls: FetchCall[] = calls;
    globalThis.fetch = (async (
      input: unknown,
      init?: { method?: string; body?: unknown },
    ): Promise<unknown> => {
      const url = String(input);
      const method = init?.method ?? "GET";
      pendingCalls.push({
        url,
        method,
        body: init?.body !== undefined ? String(init.body) : undefined,
      });
      if (method === "POST") {
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      const v = await gate;
      return { ok: true, status: 200, json: async () => v };
    }) as unknown as typeof fetch;
    const view = render(card());
    // 尚未排空：GET 未 resolve，仍为加载态（覆盖 L25 null 分支 + L37 未触发分支）
    expect(view.getByText("settingsLoading").className).toBe("dm-set-body");
    expect(posts()).toEqual([]);
    // 放行后排空即进入加载完成态
    resolveGet(baseCfg());
    await act(async () => {});
    expect(view.container.querySelector(".dm-set-save")).not.toBe(null);
    expect(view.container.querySelector(".dm-set-name")).toBe(null);
    expect(view.container.querySelector(".dm-set-description")).toBe(null);
    expect(posts()).toEqual([]);
  });

  it("GET 对象回执后渲染卡片（L25 对象分支 + L37 对象守卫）", async () => {
    const view = await mountPage();
    // row owner 已提供 title/description；page 只提供字段、保存和反馈。
    expect(view.queryByText("settingsName")).toBe(null);
    expect(view.queryByText("settingsDescription")).toBe(null);
    const select = view.container.querySelector("#dm-set-position") as HTMLSelectElement;
    expect(select.value).toBe("top-right");
    // 四个数字输入初值精确
    const inputs = Array.from(
      view.container.querySelectorAll<HTMLInputElement>("input.dm-set-input"),
    );
    expect(inputs.map((el) => el.value)).toEqual(["8", "8", "40", "3000"]);
    expect(posts()).toEqual([]);
  });

  it("GET 非对象回执时保持加载态（L37 守卫：null 不 setCfg）", async () => {
    getPayload = null;
    const view = render(card());
    await act(async () => {});
    expect(view.getByText("settingsLoading").className).toBe("dm-set-body");
    expect(view.queryByText("settingsName")).toBe(null);
    expect(posts()).toEqual([]);
  });
});

describe("SettingsCard 编辑与保存", () => {
  it("数字输入改 offsetX 后 POST 精确 body（L56 patch + L67 clamp + L80 spread 超集）", async () => {
    const view = await mountPage();
    const inputs = Array.from(
      view.container.querySelectorAll<HTMLInputElement>("input.dm-set-input"),
    );
    // 第二个数字输入是 offsetX? 顺序：offsetX/offsetY/blankY/zIndexBase
    fireEvent.change(inputs[0], { target: { value: "20" } });
    expect(inputs[0].value).toBe("20");
    fireEvent.click(view.getByRole("button", { name: "save" }));
    await act(async () => {});
    expect(posts().length).toBe(1);
    expect(posts()[0].url).toBe("/api/dsh-mcp/config");
    expect(lastPostBody()).toEqual({
      position: "top-right",
      offsetX: 20,
      offsetY: 8,
      blankY: 40,
      zIndexBase: 3000,
    });
  });

  it("锚点下拉改 position 后写回（L136 select onChange + L56 patch）", async () => {
    const view = await mountPage();
    const select = view.container.querySelector("#dm-set-position") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "bottom-left" } });
    expect(select.value).toBe("bottom-left");
    fireEvent.click(view.getByRole("button", { name: "save" }));
    await act(async () => {});
    expect(lastPostBody()).toEqual({
      position: "bottom-left",
      offsetX: 8,
      offsetY: 8,
      blankY: 40,
      zIndexBase: 3000,
    });
  });

  it("不点保存即零 POST（L80 未触发分支）", async () => {
    const view = await mountPage();
    const inputs = Array.from(
      view.container.querySelectorAll<HTMLInputElement>("input.dm-set-input"),
    );
    fireEvent.change(inputs[1], { target: { value: "15" } });
    // 只改不存：POST 仍为零（精确 body 的反面锚点）
    expect(posts()).toEqual([]);
    view.unmount();
  });

  it("保存成功文案 class 为 dm-set-saved（L80 成功分支）", async () => {
    const view = await mountPage();
    fireEvent.click(view.getByRole("button", { name: "save" }));
    await act(async () => {});
    expect(view.getByText("settingsSavedOk").className).toBe("dm-set-saved");
    expect(lastPostBody()).toEqual(baseCfg());
  });

  it("保存失败文案 class 为 dm-set-error（L80 catch 分支）", async () => {
    postReply = async () => ({ ok: false, body: { error: "boom" } });
    const view = await mountPage();
    fireEvent.click(view.getByRole("button", { name: "save" }));
    await act(async () => {});
    // t 回落 key 本体：saveFail key + msg 插值不在此断，只断 class 归属
    const err = view.container.querySelector(".dm-set-error");
    expect(err === null).toBe(false);
    expect(posts().length).toBe(1);
  });

  it("飞行中保存按钮禁用（saving 态），落地后恢复", async () => {
    let resolvePost!: (v: { ok: boolean; body: unknown }) => void;
    postDeferred = {
      promise: new Promise((done) => {
        resolvePost = done;
      }),
      resolve: resolvePost!,
    };
    // 上面构造时 resolve 未赋值，改用显式 deferred
    const gate = new Promise<{ ok: boolean; body: unknown }>((done) => {
      resolvePost = done;
    });
    postDeferred = { promise: gate, resolve: (v) => resolvePost(v) };
    const view = await mountPage();
    const saveBtn = view.getByRole("button", { name: "save" }) as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    fireEvent.click(saveBtn);
    // 同步段内即禁用（saving=true 先于 await），不需 act 排空
    expect(saveBtn.disabled).toBe(true);
    resolvePost(okWrap({ ok: true }));
    await act(async () => {});
    expect((view.getByRole("button", { name: "save" }) as HTMLButtonElement).disabled).toBe(false);
    expect(view.getByText("settingsSavedOk").className).toBe("dm-set-saved");
  });
});
