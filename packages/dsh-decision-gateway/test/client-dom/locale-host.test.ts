// @vitest-environment happy-dom
/** dsh-decision-gateway 宿主 locale 接线（happy-dom 经真实 apply）。
 *
 * 守的是 P2 locale 订阅：字典以 decision-gateway 命名空间注册、bind 带接收者装配、
 * 订阅回调重绑（切语言免刷新跟随）、label 保持 thunk、卸载摘除订阅并摘绑定回落；
 * 旧运行时（无 locale 服务 / 无 getSnapshot / register 抛错）回落本地字典。
 * 任一接线改动（命名空间串包、detached 调用、订阅泄漏）本文件必红。
 */
import { afterEach, describe, expect, it } from "vitest";
import { apply, inject } from "../../src/client/index.tsx";
import { setLang, t, unbindTranslate } from "../../src/client/locale.ts";
import { en, zh } from "../../src/client/locales.ts";

afterEach(() => {
  unbindTranslate();
  setLang("zh");
});

interface RegisterCall {
  readonly ns: string;
  readonly dict: { readonly zh: unknown; readonly en: unknown };
}

interface HostHandle {
  readonly calls: {
    readonly register: RegisterCall[];
    readonly bindNs: string[];
  };
  hostLang: "zh" | "en";
  fire(): void;
  unsubscribed: boolean;
  readonly locale: Record<string, unknown>;
}

function installHost(options?: {
  readonly withoutSnapshot?: boolean;
  readonly subscribeResult?: "fn" | "undefined";
  readonly registerThrows?: boolean;
  readonly bindResult?: "fn" | "undefined" | "throws";
}): { readonly effects: Array<() => void>; readonly host: HostHandle } {
  const effects: Array<() => void> = [];
  const calls = { register: [] as RegisterCall[], bindNs: [] as string[] };
  const state = {
    lang: "zh" as "zh" | "en",
    unsubscribed: false,
    listener: null as (() => void) | null,
  };
  const host = {
    calls,
    get hostLang() {
      return state.lang;
    },
    set hostLang(next: "zh" | "en") {
      state.lang = next;
    },
    fire() {
      state.listener?.();
    },
    get unsubscribed() {
      return state.unsubscribed;
    },
    locale: {} as Record<string, unknown>,
  };
  host.locale = {
    register: (ns: string, dict: { zh: unknown; en: unknown }) => {
      if (options?.registerThrows === true) throw new Error("register 炸");
      calls.register.push({ ns, dict });
    },
    bind: function (this: unknown, ns: string) {
      calls.bindNs.push(ns);
      if (options?.bindResult === "throws") throw new Error("bind 炸");
      if (options?.bindResult === "undefined") return undefined;
      return (key: string) => {
        const table =
          state.lang === "zh" ? (zh as Record<string, string>) : (en as Record<string, string>);
        return table[key] ?? key;
      };
    },
    ...(options?.withoutSnapshot === true
      ? {}
      : {
          getSnapshot: () => state.lang,
          subscribe: (listener: () => void) => {
            state.listener = listener;
            if (options?.subscribeResult === "undefined") return undefined;
            return () => {
              state.unsubscribed = true;
            };
          },
        }),
  };
  const slots = {
    inject: (name: string, setup: () => unknown) => {
      if (name === "settings.section") setup();
      return () => {};
    },
    register: (item: unknown, _render: () => unknown) => {
      (host as unknown as { item: unknown }).item = item;
      return () => {};
    },
  };
  const ctx = {
    get: (name: string) => {
      if (name === "slots") return slots;
      if (name === "locale") return host.locale;
      return undefined;
    },
    effect: (fn: () => () => void) => {
      effects.push(fn());
    },
  };
  apply(ctx as never);
  return { effects, host: host as unknown as HostHandle };
}

describe("宿主 locale 接线", () => {
  it("inject 声明 locale（与 ctx.get 对齐）", () => {
    expect(inject).toEqual(["slots", "locale"]);
  });
  it("字典以 decision-gateway 注册并装配 bind，切语言经订阅重绑免刷新跟随", () => {
    const { host } = installHost();
    expect(host.calls.register).toHaveLength(1);
    expect(host.calls.register[0]?.ns).toBe("decision-gateway");
    expect(host.calls.register[0]?.dict.zh).toBe(zh);
    expect(host.calls.register[0]?.dict.en).toBe(en);
    expect(host.calls.bindNs).toEqual(["decision-gateway"]);
    // 装配走宿主实现（中文）。
    expect(t("save")).toBe("保存");
    // 切语言：宿主侧改语言后触发订阅回调，重绑后 t 即跟随，无需刷新。
    host.hostLang = "en";
    host.fire();
    expect(host.calls.bindNs).toEqual(["decision-gateway", "decision-gateway"]);
    expect(t("save")).toBe("Save");
    expect(t("detail")).toBe("Details");
  });
  it("label 保持 thunk：每次读取经当前绑定求值", () => {
    const { host } = installHost();
    const item = (host as unknown as { item: { label: () => string } }).item;
    expect(typeof item.label).toBe("function");
    expect(item.label()).toBe("JEV 决策");
    host.hostLang = "en";
    host.fire();
    expect(item.label()).toBe("JEV Decide");
  });
  it("卸载摘除订阅（disposer 配对）", () => {
    const { effects, host } = installHost();
    // 订阅 disposer + 样式 disposer。
    expect(effects).toHaveLength(2);
    host.hostLang = "en";
    host.fire();
    expect(t("save")).toBe("Save");
    // 本地回落语言对齐英文（afterEach 置 zh 会污染 current，此处显式复位；
    // node 无 navigator 时 resolveLang 为 en）。
    setLang("en");
    for (const dispose of effects) dispose();
    expect(host.unsubscribed).toBe(true);
    expect(t("save")).toBe("Save");
    setLang("zh");
    // 若未 unbind，此处仍走宿主英文实现而变红——真区分断言。
    expect(t("save")).toBe("保存");
  });
  it("无 locale 服务回落本地字典（旧运行时照常渲染）", () => {
    const effects: Array<() => void> = [];
    const slots = {
      inject: (name: string, setup: () => unknown) => {
        if (name === "settings.section") setup();
        return () => {};
      },
      register: () => () => {},
    };
    apply({
      get: (name: string) => (name === "slots" ? slots : undefined),
      effect: (fn: () => () => void) => {
        effects.push(fn());
      },
    } as never);
    setLang("zh");
    expect(t("save")).toBe("保存");
    expect(effects).toHaveLength(1);
  });
  it("register 抛错被兜住：不抛、回落本地字典", () => {
    const { host } = installHost({ registerThrows: true });
    expect(host.calls.bindNs).toEqual([]);
    setLang("en");
    expect(t("save")).toBe("Save");
  });
  it("缺 getSnapshot 不订阅（只留样式 disposer）", () => {
    const { effects } = installHost({ withoutSnapshot: true });
    setLang("zh");
    // bind 已装配但无订阅：卸载只有样式一项。
    expect(t("save")).toBe("保存");
    expect(effects).toHaveLength(1);
  });
  it("subscribe 返回 undefined 不登记卸载（notifier 同款 undefined 形态）", () => {
    const { effects } = installHost({ subscribeResult: "undefined" });
    expect(effects).toHaveLength(1);
  });
  it("bind 返回非函数：不抛、回落本地字典、不订阅", () => {
    const { effects, host } = installHost({ bindResult: "undefined" });
    setLang("zh");
    // 初绑失败：t 走本地字典，且未登记订阅（与重构前语义一致）。
    expect(t("save")).toBe("保存");
    expect(effects).toHaveLength(1);
    // 订阅未登记，无回调可触发；再调一次 apply 级 fire 也不崩（listener 为空）。
    host.fire();
    expect(t("save")).toBe("保存");
    expect(host.calls.bindNs).toEqual(["decision-gateway"]);
  });
  it("bind 抛错：不抛、回落本地字典、不订阅", () => {
    const { effects } = installHost({ bindResult: "throws" });
    setLang("en");
    expect(t("save")).toBe("Save");
    expect(effects).toHaveLength(1);
  });
});
