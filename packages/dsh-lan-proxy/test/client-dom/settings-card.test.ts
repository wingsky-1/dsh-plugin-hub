// @vitest-environment happy-dom
/**
 * 真实 React 卡片经浏览器 fetch 接缝测试；手写替身只记录请求、交付响应。
 * act 排空 Promise，计时器用显式假钟推进，不访问真实网络或设置存储。
 */
import * as React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsCard } from "../../src/client/settings-card.tsx";

const originalFetch = globalThis.fetch;
let writes: unknown[];
let reply: () => Promise<Response>;
let initial: unknown;
let health: unknown;
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  writes = [];
  initial = { effective: { port: 4000 }, user: {}, revision: 0 };
  health = {};
  reply = async () => json({ ok: true, revision: 1 });
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      return reply();
    }
    return json(String(input).endsWith("/config") ? initial : health);
  };
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});
const card = () =>
  React.createElement(SettingsCard, {
    hostTrustSignals: () => ({ hostname: "localhost" }),
  });
async function mountCard() {
  const view = render(card());
  await act(async () => {});
  fireEvent.click(view.getByRole("button", { name: /settingsName/ }));
  return view;
}
type View = Awaited<ReturnType<typeof mountCard>>;
function save(view: View) {
  fireEvent.click(view.getByRole("button", { name: "save" }));
}
function port(view: View, value: string) {
  fireEvent.change(view.getByLabelText("lanPort"), { target: { value } });
}

describe("SettingsCard 输入与显示契约", () => {
  it.each([
    ["enable", "enabled", true],
    ["httpsCoexist", "httpsEnabled", true],
    ["printBanner", "printBanner", true],
    ["wsBridge", "wsBridgeEnabled", true],
    ["wsCompress", "wsCompressEnabled", true],
    ["httpCompress", "httpCompressEnabled", true],
    ["injectToken", "injectToken", true],
    ["ownsHostCompat", "ownsHostCompat", false],
  ] as const)("%s 默认值与开关写回", async (label, key, checked) => {
    initial = { revision: 0 };
    const view = await mountCard();
    const input = view.getByLabelText(label) as HTMLInputElement;
    expect(input.checked).toBe(checked);
    fireEvent.click(input);
    expect(input.checked).toBe(!checked);
    save(view);
    expect(writes).toEqual([{ patch: { [key]: !checked }, expectedRevision: 0 }]);
    await act(async () => {});
  });
  it.each([
    ["httpsPort", "httpsPort", "4443", 4443],
    ["certFile", "tlsCertFile", "/tmp/cert.pem", "/tmp/cert.pem"],
    ["keyFile", "tlsKeyFile", "/tmp/key.pem", "/tmp/key.pem"],
    ["compressLevel", "httpCompressLevel", "3", 3],
    ["wsPaths", "wsCompressPaths", " /a, , /b ", ["/a", "/b"]],
  ] as const)("%s 只写对应字段", async (label, key, text, value) => {
    const view = await mountCard();
    fireEvent.change(view.getByLabelText(label), { target: { value: text } });
    save(view);
    expect(writes).toEqual([{ patch: { [key]: value }, expectedRevision: 0 }]);
    await act(async () => {});
  });
  it.each(["0", "65536", "1.5"])("非法HTTP端口%s零请求", async (value) => {
    const view = await mountCard();
    port(view, value);
    save(view);
    expect(view.getByText("portRangeFail").className).toBe("lp-set-error");
    expect(writes).toEqual([]);
  });
  it.each(["0", "65536", "1.5"])("非法HTTPS端口%s零请求", async (value) => {
    const view = await mountCard();
    fireEvent.change(view.getByLabelText("httpsPort"), { target: { value } });
    save(view);
    expect(view.getByText("httpsPortRangeFail").className).toBe("lp-set-error");
    expect(writes).toEqual([]);
  });
  it.each([-1, 4, 1.5])("非法加载压缩档位%s不能保存", async (value) => {
    initial = { effective: { httpCompressLevel: value }, revision: 0 };
    const view = await mountCard();
    save(view);
    expect(view.getByText("levelRangeFail").className).toBe("lp-set-error");
    expect(writes).toEqual([]);
  });
  it("默认端口和压缩值、用户层优先与告警显隐", async () => {
    initial = { effective: { port: 4400 }, user: { port: 4500 }, revision: 0 };
    const view = await mountCard();
    expect((view.getByLabelText("lanPort") as HTMLInputElement).value).toBe("4500");
    expect((view.getByLabelText("httpsPort") as HTMLInputElement).value).toBe("3443");
    expect((view.getByLabelText("compressLevel") as HTMLSelectElement).value).toBe("1");
    expect(view.getByText("injectTokenOnHint").className).toBe("lp-set-warn");
    fireEvent.click(view.getByLabelText("injectToken"));
    expect(view.queryByText("injectTokenOnHint")).toBe(null);
    expect(view.queryByText("ownsHostCompatHint")).toBe(null);
    fireEvent.click(view.getByLabelText("ownsHostCompat"));
    expect(view.getByText("ownsHostCompatHint").className).toBe("lp-set-warn");
  });
  it.each([
    [{ httpCompressEnabled: false }, "compressOff"],
    [{ httpCompressEnabled: true, httpCompressMounted: false }, "compressInactive"],
    [{ httpCompressEnabled: true, httpCompressMounted: true }, "compressOn"],
  ])("压缩运行快照对应状态 %s", async (compress, expected) => {
    initial = { compress, revision: 0 };
    const view = await mountCard();
    expect(view.getByText(String(expected)).className).toBe("lp-set-status");
  });
});

describe("SettingsCard 保存基线", () => {
  it("GET 完成并重渲染后，未修改时不发送 PUT", async () => {
    const view = await mountCard();
    save(view);
    expect(writes).toEqual([]);
  });
  it("单键编辑只提交该键，并保留 revision 0", async () => {
    const view = await mountCard();
    port(view, "4100");
    save(view);
    expect(writes).toEqual([{ patch: { port: 4100 }, expectedRevision: 0 }]);
    await act(async () => {});
  });
  it("规范化数字与同内容数组不产生伪差异", async () => {
    const view = await mountCard();
    port(view, "4000");
    fireEvent.change(view.getByLabelText("wsPaths"), { target: { value: " /api/remote.mux, " } });
    save(view);
    expect(writes).toEqual([]);
  });
  it("成功后基线使用规范化值，后续提交携带新版本", async () => {
    const view = await mountCard();
    port(view, "4100");
    save(view);
    await act(async () => {});
    save(view);
    expect(writes).toEqual([{ patch: { port: 4100 }, expectedRevision: 0 }]);
    port(view, "4200");
    save(view);
    expect(writes).toEqual([
      { patch: { port: 4100 }, expectedRevision: 0 },
      { patch: { port: 4200 }, expectedRevision: 1 },
    ]);
    await act(async () => {});
  });
  it("409 保留草稿与旧版本且不显示成功", async () => {
    reply = async () =>
      json({ error: { code: "conflict", details: "设置已被其他窗口修改，请刷新后重试" } }, 409);
    const view = await mountCard();
    port(view, "4100");
    save(view);
    await act(async () => {});
    expect(view.getByText("saveFailConflict").className).toBe("lp-set-error");
    expect(view.queryByText("savedOk")).toBe(null);
    expect((view.getByLabelText("lanPort") as HTMLInputElement).value).toBe("4100");
    save(view);
    expect(writes).toEqual([
      { patch: { port: 4100 }, expectedRevision: 0 },
      { patch: { port: 4100 }, expectedRevision: 0 },
    ]);
    await act(async () => {});
  });
  it("等待期间继续编辑，响应只确认已提交快照且阻止重复保存", async () => {
    const pending = deferred();
    reply = () => pending.promise;
    const view = await mountCard();
    port(view, "4100");
    save(view);
    const button = view.getByRole("button", { name: "save" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    port(view, "4200");
    save(view);
    expect(writes).toEqual([{ patch: { port: 4100 }, expectedRevision: 0 }]);
    await act(async () => {
      pending.resolve(json({ revision: 7 }));
    });
    expect(button.disabled).toBe(false);
    expect((view.getByLabelText("lanPort") as HTMLInputElement).value).toBe("4200");
    reply = async () => json({ revision: 8 });
    save(view);
    expect(writes).toEqual([
      { patch: { port: 4100 }, expectedRevision: 0 },
      { patch: { port: 4200 }, expectedRevision: 7 },
    ]);
    await act(async () => {});
  });
  it("成功反馈保持到2.2秒后清除", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const view = await mountCard();
    port(view, "4100");
    save(view);
    await act(async () => {});
    expect(view.getByText("savedOk").className).toBe("lp-set-saved");
    await act(async () => {
      vi.advanceTimersByTime(2199);
    });
    expect(view.getByText("savedOk").className).toBe("lp-set-saved");
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(view.queryByText("savedOk")).toBe(null);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("卸载后成功响应不创建反馈计时器", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const pending = deferred();
    reply = () => pending.promise;
    const view = await mountCard();
    port(view, "4100");
    save(view);
    view.unmount();
    await act(async () => {
      pending.resolve(json({ revision: 3 }));
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("新错误不会被旧成功反馈计时器清除，卸载清理反馈", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const view = await mountCard();
    port(view, "4100");
    save(view);
    await act(async () => {});
    expect(vi.getTimerCount()).toBe(1);
    port(view, "0");
    save(view);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(2200);
    });
    expect(view.getByText("portRangeFail").className).toBe("lp-set-error");
    port(view, "4200");
    save(view);
    await act(async () => {});
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("StrictMode 废弃 GET 不覆盖新代基线或版本", async () => {
    const gets: ReturnType<typeof deferred>[] = [];
    const servingFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (!init?.method && String(input).endsWith("/config")) {
        const pending = deferred();
        gets.push(pending);
        return pending.promise;
      }
      return servingFetch(input, init);
    };
    const view = render(React.createElement(React.StrictMode, null, card()));
    expect(gets.length).toBe(2);
    await act(async () => {
      gets[1].resolve(json({ effective: { port: 4300 }, revision: 9 }));
    });
    await act(async () => {
      gets[0].resolve(json({ effective: { port: 4000 }, revision: 1 }));
    });
    fireEvent.click(view.getByRole("button", { name: /settingsName/ }));
    expect((view.getByLabelText("lanPort") as HTMLInputElement).value).toBe("4300");
    port(view, "4400");
    save(view);
    expect(writes).toEqual([{ patch: { port: 4400 }, expectedRevision: 9 }]);
    await act(async () => {});
  });
});

describe("SettingsCard 加载失败（CRAP 20/4 未覆盖 → 覆盖后 4）", () => {
  it("GET 失败走 catch 且保持加载态（loadFail 分支覆盖）", async () => {
    const servingFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (!init?.method && String(input).endsWith("/config")) throw new Error("boom-load");
      return servingFetch(input, init);
    };
    const view = render(card());
    await act(async () => {});
    expect(view.getByText("settingsLoading")).toBeTruthy();
  });
});
