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
let requests: string[];
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
let caWrites: unknown[];
let caReply: () => Promise<Response>;
beforeEach(() => {
  writes = [];
  caWrites = [];
  initial = { effective: { port: 4000 }, user: {}, revision: 0 };
  health = {};
  requests = [];
  reply = async () => json({ ok: true, revision: 1 });
  caReply = async () => json({ ok: true, mode: "generated" });
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PUT") {
      writes.push(JSON.parse(String(init.body)));
      return reply();
    }
    if (init?.method === "POST") {
      caWrites.push(JSON.parse(String(init.body)));
      return caReply();
    }
    if (init?.method === undefined) requests.push(String(input));
    return json(String(input).endsWith("/config") ? initial : health);
  };
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});
const card = (view: "summary" | "page" = "page") =>
  React.createElement(SettingsCard, {
    view,
    hostTrustSignals: () => ({ hostname: "localhost" }),
  });
async function mountRowEntry(view: "summary" | "page") {
  const ownerKey = "@wingsky-1/dsh-lan-proxy#dsh-lan-proxy";
  const host =
    view === "summary"
      ? React.createElement("p", { "data-plugin-row-detail": ownerKey }, card(view))
      : React.createElement("div", { "data-plugin-config": true }, card(view));
  const rendered = render(host);
  await act(async () => {});
  return rendered;
}

async function mountCard(view: "summary" | "page" = "page") {
  return mountRowEntry(view);
}
type View = Awaited<ReturnType<typeof mountCard>>;
function save(view: View) {
  fireEvent.click(view.getByRole("button", { name: "save" }));
}
function port(view: View, value: string) {
  fireEvent.change(view.getByLabelText("lanPort"), { target: { value } });
}

describe("SettingsCard row view 契约", () => {
  it("summary 在官方描述容器内只返回非-li 摘要，不请求 config/health", async () => {
    const view = await mountRowEntry("summary");
    const summary = view.container.querySelector("[data-lan-summary]");
    expect(requests).toEqual([]);
    expect(view.container.querySelector("li")).toBe(null);
    expect(summary?.tagName).toBe("SPAN");
    expect(summary?.parentElement?.tagName).toBe("P");
    expect(summary?.textContent).toBe("settingsDescription");
  });

  it("page 直接使用非-li wrapper 显示字段和保存控件，各加载一次 config/health", async () => {
    const view = await mountRowEntry("page");
    const page = view.container.querySelector("[data-lan-page]");
    expect(page?.tagName).toBe("DIV");
    expect(view.container.querySelector("li")).toBe(null);
    expect(view.container.querySelector(".lp-set-body")).toBeTruthy();
    expect(view.container.querySelector(".lp-set-head")).toBe(null);
    expect(view.queryByText("settingsName")).toBe(null);
    expect(view.queryByText("settingsDescription")).toBe(null);
    const portInput = view.getByLabelText("lanPort") as HTMLInputElement;
    const saveButton = view.getByRole("button", { name: "save" }) as HTMLButtonElement;
    expect(portInput.disabled).toBe(false);
    expect(saveButton.disabled).toBe(false);
    expect(requests).toEqual(["/api/dsh-lan-proxy/config", "/api/dsh-lan-proxy/health"]);
  });
});

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
    ["caCertFile", "tlsCaCertFile", "/tmp/ca.pem", "/tmp/ca.pem"],
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
  it("CA 下载为直接导航链接（禁 fetch/blob，iOS 安装引导要求）", async () => {
    const view = await mountCard();
    const link = view.getByText("caDownloadLink").closest("a");
    expect(link?.getAttribute("href") ?? "").toMatch(/\/api\/dsh-lan-proxy\/ca-cert\?format=cer$/);
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

describe("SettingsCard 一键 CA 状态行与按钮（issue #930）", () => {
  it("自签态：置灰 + 锚点链到生成按钮 + 按钮可用", async () => {
    health = { caState: "self-signed" };
    const view = await mountCard();
    expect(view.getByText("caModeSelfSigned").dataset.caState).toBe("self-signed");
    expect(view.getByText("caDisabledNoCa")).toBeTruthy();
    const anchor = view.container.querySelector('a[href="#lp-ca-generate"]');
    expect(anchor?.textContent).toBe("caGenerate");
    const button = view.getByRole("button", { name: "caGenerate" });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });
  it("托管态：双按钮 + 到期/IP 双提醒（https 开）", async () => {
    health = {
      caState: "managed",
      caConfigured: true,
      certInfo: {
        leafValidTo: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
        leafSans: ["DNS:localhost", "IP Address:127.0.0.1", "IP Address:192.168.1.5"],
        currentIps: ["192.168.1.5", "192.168.2.9"],
      },
    };
    initial = { effective: { port: 4000, httpsEnabled: true }, user: {}, revision: 0 };
    const view = await mountCard();
    expect(view.getByText("caModeManaged")).toBeTruthy();
    expect(view.getByRole("button", { name: "caRotate" })).toBeTruthy();
    expect(view.getByRole("button", { name: "caRotateCa" })).toBeTruthy();
    expect(view.getByText("caExpiring")).toBeTruthy();
    expect(view.getByText("caIpChanged")).toBeTruthy();
  });
  it("托管态 https 关即不提醒（HTTP-only 无叶子不提醒）", async () => {
    health = {
      caState: "managed",
      certInfo: {
        leafValidTo: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
        leafSans: [],
        currentIps: ["192.168.2.9"],
      },
    };
    initial = { effective: { port: 4000, httpsEnabled: false }, user: {}, revision: 0 };
    const view = await mountCard();
    expect(view.getByText("caModeManaged")).toBeTruthy();
    expect(view.queryByText("caExpiring")).toBe(null);
    expect(view.queryByText("caIpChanged")).toBe(null);
  });
  it("自定义态：置灰 + 生成按钮禁用（服务端亦 409）", async () => {
    health = { caState: "custom", caConfigured: false };
    const view = await mountCard();
    expect(view.getByText("caModeCustom")).toBeTruthy();
    expect(view.getByText("caDisabledNoCa")).toBeTruthy();
    const buttons = view.getAllByRole("button", { name: "caGenerate" });
    const action = buttons.find((b) => (b as HTMLButtonElement).disabled);
    expect(action).toBeTruthy();
  });
  it("异常态：配置异常文案", async () => {
    health = { caState: "error" };
    const view = await mountCard();
    expect(view.getByText("caConfigError")).toBeTruthy();
    expect(view.getByText("caFilesMissing")).toBeTruthy();
  });
  it("异常态一键清空：PUT 三键空串走服务端清空路径", async () => {
    health = { caState: "error" };
    initial = {
      effective: { port: 4000 },
      user: { tlsCertFile: "/x/c.pem", tlsKeyFile: "/x/k.pem", tlsCaCertFile: "/x/ca.pem" },
      revision: 0,
    };
    const view = await mountCard();
    const anchor = view.container.querySelector('a[href="#lp-ca-generate"]');
    expect(anchor?.textContent).toBe("caClearSelfSigned");
    // 草稿另有未保存改动（端口）：隔离 PUT 不得将其合并带入。
    port(view, "4100");
    fireEvent.click(view.getByRole("button", { name: "caClearSelfSigned" }));
    await act(async () => {});
    expect(writes).toEqual([
      {
        patch: { tlsCertFile: "", tlsKeyFile: "", tlsCaCertFile: "" },
        expectedRevision: 0,
      },
    ]);
  });
});

describe("SettingsCard 一键 CA 动作提交", () => {
  it("自签首建直发空确认：POST 无 confirmed，成功即时重 fetch", async () => {
    health = { caState: "self-signed" };
    let gets = 0;
    const servingFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      if (!init?.method && String(input).endsWith("/config")) gets += 1;
      return servingFetch(input, init);
    };
    const view = await mountCard();
    const before = gets;
    fireEvent.click(view.getByRole("button", { name: "caGenerate" }));
    await act(async () => {});
    expect(caWrites).toEqual([{ expectedRevision: 0 }]);
    expect(view.getByText("caGeneratedOk")).toBeTruthy();
    expect(gets).toBeGreaterThan(before);
  });
  it("残留 409 回来弹确认框：确认后补 confirmed:true 重发", async () => {
    health = { caState: "self-signed" };
    caReply = async () => json({ error: { code: "needs-confirm", details: "确认" } }, 409);
    const view = await mountCard();
    fireEvent.click(view.getByRole("button", { name: "caGenerate" }));
    await act(async () => {});
    expect(view.getByText("caConfirmTitle")).toBeTruthy();
    caReply = async () => json({ ok: true, mode: "generated" });
    const confirms = view.getAllByRole("button", { name: "caGenerate" });
    expect(confirms.length).toBe(2);
    fireEvent.click(confirms[1]);
    await act(async () => {});
    expect(caWrites).toEqual([{ expectedRevision: 0 }, { expectedRevision: 0, confirmed: true }]);
    expect(view.getByText("caGeneratedOk")).toBeTruthy();
  });
  it("缺 revision 409 显示专用文案 caRevisionStale（不复用冲突文案）", async () => {
    health = { caState: "self-signed" };
    caReply = async () =>
      json({ error: { code: "ca-revision-stale", details: "配置版本未知，请刷新后重试" } }, 409);
    const view = await mountCard();
    fireEvent.click(view.getByRole("button", { name: "caGenerate" }));
    await act(async () => {});
    expect(view.getByText("caRevisionStale").className).toBe("lp-set-error");
    expect(view.queryByText("caConfirmTitle")).toBe(null);
  });
  it("叶子轮换经确认框：POST 带 confirmed 不带 rotateCa；取消可关框", async () => {
    health = { caState: "managed" };
    const view = await mountCard();
    fireEvent.click(view.getByRole("button", { name: "caRotate" }));
    expect(view.getByText("caConfirmTitle")).toBeTruthy();
    expect(view.getByText("caConfirmBody")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "caConfirmCancel" }));
    await act(async () => {});
    expect(view.queryByText("caConfirmTitle")).toBe(null);
    expect(caWrites).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "caRotate" }));
    const confirms = view.getAllByRole("button", { name: "caRotate" });
    expect(confirms.length).toBe(2);
    fireEvent.click(confirms[1]);
    await act(async () => {});
    expect(caWrites).toEqual([{ expectedRevision: 0, confirmed: true }]);
  });
  it("CA 轮换经确认框：POST 带 rotateCa:true", async () => {
    health = { caState: "managed" };
    const view = await mountCard();
    fireEvent.click(view.getByRole("button", { name: "caRotateCa" }));
    const confirms = view.getAllByRole("button", { name: "caRotateCa" });
    expect(confirms.length).toBe(2);
    fireEvent.click(confirms[1]);
    await act(async () => {});
    expect(caWrites).toEqual([{ expectedRevision: 0, confirmed: true, rotateCa: true }]);
  });
  it("失败走 caGenerateFail 且飞行中按钮禁用", async () => {
    health = { caState: "managed" };
    const pending = deferred();
    caReply = () => pending.promise;
    const view = await mountCard();
    fireEvent.click(view.getByRole("button", { name: "caRotate" }));
    const confirms = view.getAllByRole("button", { name: "caRotate" });
    expect(confirms.length).toBe(2);
    fireEvent.click(confirms[1]);
    expect((confirms[0] as HTMLButtonElement).disabled).toBe(true);
    expect((confirms[1] as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      pending.resolve(json({ error: { code: "ca-generate-failed", details: "boom" } }, 500));
    });
    expect(view.getByText("caGenerateFail")).toBeTruthy();
  });
});

describe("SettingsCard L718 载荷容错（#732 T3-B 缺口先锁）", () => {
  // 缺口枚举（以源码分支为准，只补 L718 Config 合并箭头相关的，不硬凑）：
  // a) v 为 null → 回落 DEFAULTS 且 revision 为空：fetch json 的 null 分支，原 (v && v.effective) || {} 等三处回落均未锁。
  // b) effective 显式 null 不覆盖 DEFAULTS：原 effective[ek] !== null 的 null 半支未锁。
  // c/d) revision 为字符串/小数 → 归 null：与「缺键 undefined」是同函数不同分支，it.each 合批。
  it("a) config 为 null 时回落 DEFAULTS 且保存带 null 版本", async () => {
    initial = null;
    const view = await mountCard();
    expect((view.getByLabelText("lanPort") as HTMLInputElement).value).toBe("3081");
    expect((view.getByLabelText("httpsPort") as HTMLInputElement).value).toBe("3443");
    port(view, "4100");
    save(view);
    expect(writes).toEqual([{ patch: { port: 4100 }, expectedRevision: null }]);
    await act(async () => {});
  });
  it("b) effective 显式 null 不覆盖 DEFAULTS", async () => {
    initial = { effective: { port: null, httpsPort: null }, user: {}, revision: 0 };
    const view = await mountCard();
    expect((view.getByLabelText("lanPort") as HTMLInputElement).value).toBe("3081");
    expect((view.getByLabelText("httpsPort") as HTMLInputElement).value).toBe("3443");
    save(view);
    expect(writes).toEqual([]);
    await act(async () => {});
  });
  it.each(["1", 1.5] as const)(
    "c-d) 非整数 revision %s 归空，后续保存带 null 版本",
    async (badRevision) => {
      initial = { effective: { port: 4000 }, user: {}, revision: badRevision };
      const view = await mountCard();
      expect((view.getByLabelText("lanPort") as HTMLInputElement).value).toBe("4000");
      port(view, "4100");
      save(view);
      expect(writes).toEqual([{ patch: { port: 4100 }, expectedRevision: null }]);
      await act(async () => {});
    },
  );
});
