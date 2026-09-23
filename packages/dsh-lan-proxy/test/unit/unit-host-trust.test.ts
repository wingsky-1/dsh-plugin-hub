/**
 * dsh-lan-proxy — 宿主端 host trust 兼容注入的直连判据（issue #856，src 层）。
 *
 * 判据分两段：
 * 1. 纯函数 `applyHostTrustInjection`：在 `node:vm` 里**真执行**注入脚本，证明
 *    「非回环才写 / 预置 transport 的字段存活 / 幂等 / 关时逐字节不变」——整体赋值
 *    与 `kind: "global"` 行这两种写法都会在这里被打红；
 * 2. apply 接线：tap 只在顶层注册一次（跨多次 sync）、开关逐请求读取、dispose 后消失。
 *
 * 顺序不变量用官方纯函数 `renderIndexInjections` 锁：真实链是「结构化注入表 →
 * tap」，故断言注入落在官方 boot-readiness 尾脚本（`__DSH_BOOT_READY__`）之前，
 * 而不是手写期望位置。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { renderIndexInjections } from "@deepseek-ai/dsh-host-webserver";

import { apply } from "../../src/server/apply.ts";
import {
  applyHostTrustInjection,
  HOST_TRUST_ELEMENT_ID,
  HOST_TRUST_RUNTIME_MARKER,
} from "../../src/server/host-trust/impl/injection.ts";

/** 与 `dsh-web-frontend/dist/index.html` 同形的 index（module 入口在 head 内）。 */
const RAW_INDEX = [
  "<!doctype html>",
  '<html lang="en">',
  "  <head>",
  '    <meta charset="utf-8" />',
  "    <title>DeepSeek Harness</title>",
  '    <script type="module" crossorigin src="./assets/index-abc.js"></script>',
  "  </head>",
  "  <body>",
  '    <div id="root"></div>',
  "  </body>",
  "</html>",
].join("\n");

const SCRIPT_OPEN = `<script id="${HOST_TRUST_ELEMENT_ID}">`;

/** 取出注入脚本正文（不含 script 标签）。 */
function injectedScript(html: string): string {
  const at = html.indexOf(SCRIPT_OPEN);
  if (at === -1) throw new Error("注入脚本不存在");
  const start = at + SCRIPT_OPEN.length;
  const end = html.indexOf("</script>", start);
  return html.slice(start, end);
}

/**
 * vm realm 全局：location 恒有；注入脚本按条件写 `__DSH_TRANSPORT__`/marker。
 * transport 按存在声明（未写时读到 undefined）：realm 是动态全局，逐处收窄要给 6 处
 * 断言加噪，而缺失读到的 undefined 本就是部分断言的期望值，行为零差异。
 */
interface InjectedRealm {
  location: { hostname: string };
  __DSH_TRANSPORT__: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 在 `node:vm` 里执行注入脚本，返回该 realm 的全局对象。
 * `hostname` 模拟 `location.hostname`；`transport` 非 undefined 时预置前序 transport。
 */
function runInjectedScript(
  html: string,
  options: { hostname: string; transport?: Record<string, unknown> },
): InjectedRealm {
  const sandbox = { location: { hostname: options.hostname } } as InjectedRealm;
  if (options.transport !== undefined) sandbox.__DSH_TRANSPORT__ = options.transport;
  runInContext(injectedScript(html), createContext(sandbox));
  return sandbox;
}

describe("applyHostTrustInjection：自条件注入（node:vm 真执行）", () => {
  it("开关关闭时逐字节原样返回", () => {
    expect(applyHostTrustInjection(RAW_INDEX, false)).toBe(RAW_INDEX);
  });

  it("注入落在 head 内", () => {
    const out = applyHostTrustInjection(RAW_INDEX, true);
    expect(out.indexOf(SCRIPT_OPEN)).toBeGreaterThan(out.indexOf("<head>"));
    expect(out.indexOf(SCRIPT_OPEN)).toBeLessThan(out.indexOf("</head>"));
  });

  it("注入是经典内联脚本（无 type/src，故在 deferred module 入口执行前跑完）", () => {
    const out = applyHostTrustInjection(RAW_INDEX, true);
    const tagEnd = out.indexOf(">", out.indexOf(SCRIPT_OPEN)) + 1;
    expect(out.slice(out.indexOf(SCRIPT_OPEN), tagEnd)).toBe(SCRIPT_OPEN);
  });

  it("顺序不变量：与官方结构化注入表合链后，注入先于 boot-readiness 尾脚本", () => {
    const rows = [
      { kind: "script" as const, placement: "head" as const, text: "globalThis.__probeHead = 1;" },
      { kind: "script" as const, placement: "body" as const, text: "globalThis.__probeBody = 1;" },
    ];
    const rendered = applyHostTrustInjection(renderIndexInjections(RAW_INDEX, rows), true);
    const trustAt = rendered.indexOf(SCRIPT_OPEN);
    const readyAt = rendered.indexOf("__DSH_BOOT_READY__");
    expect(trustAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    expect(trustAt).toBeLessThan(readyAt);
    // 仍必须在 head 内（body 注入晚于 boot-readiness 尾脚本）
    expect(trustAt).toBeLessThan(rendered.indexOf("</head>"));
  });

  it("幂等：两次应用只注入一次", () => {
    const once = applyHostTrustInjection(RAW_INDEX, true);
    const twice = applyHostTrustInjection(once, true);
    expect(twice).toBe(once);
    expect(twice.split(SCRIPT_OPEN).length - 1).toBe(1);
  });

  it("预置前序 transport 时其字段存活（绝不整体覆盖）", () => {
    const prior = { ownsHost: false, fetch: () => "prior-fetch", custom: 42 };
    const out = applyHostTrustInjection(RAW_INDEX, true);
    const g = runInjectedScript(out, { hostname: "192.168.1.50", transport: prior });
    expect(g.__DSH_TRANSPORT__).toBe(prior);
    expect(g.__DSH_TRANSPORT__.ownsHost).toBe(false);
    expect(g.__DSH_TRANSPORT__.custom).toBe(42);
    expect(typeof g.__DSH_TRANSPORT__.fetch).toBe("function");
    // 未写 transport 就不该落 marker——观测器据此区分「生效」与「未生效」
    expect(g[HOST_TRUST_RUNTIME_MARKER]).toBeUndefined();
  });

  it("非回环页且无前序 transport 时写入 ownsHost 并落 marker", () => {
    const g = runInjectedScript(applyHostTrustInjection(RAW_INDEX, true), {
      hostname: "192.168.1.50",
    });
    expect(g.__DSH_TRANSPORT__.ownsHost).toBe(true);
    expect(Object.keys(g.__DSH_TRANSPORT__)).toEqual(["ownsHost"]);
    expect(g[HOST_TRUST_RUNTIME_MARKER]).toBe(true);
  });

  const loopbackHostnames = ["localhost", "[::1]", "127.0.0.1", "127.9.9.9"];
  it.each(loopbackHostnames)("回环 authority %s 不写入任何东西", (hostname) => {
    const g = runInjectedScript(applyHostTrustInjection(RAW_INDEX, true), { hostname });
    expect(g.__DSH_TRANSPORT__).toBeUndefined();
    expect(g[HOST_TRUST_RUNTIME_MARKER]).toBeUndefined();
  });

  const nonLoopbackHostnames = ["192.168.1.50", "10.0.0.7", "127.0.0.1.evil.example", "128.0.0.1"];
  it.each(nonLoopbackHostnames)("非回环 authority %s 照常写入", (hostname) => {
    const g = runInjectedScript(applyHostTrustInjection(RAW_INDEX, true), { hostname });
    expect(g.__DSH_TRANSPORT__.ownsHost).toBe(true);
  });
});

/** fake ctx：捕获 effect（含 label）、tapIndex 变换与 index-inject 订阅。 */
function makeHostTrustCtx() {
  const state: Record<string, unknown> = { enabled: false, ownsHostCompat: false };
  const watchers: Array<() => void> = [];
  // tap 带注册时的 effect label：只有这样才能在开关为关时仍识别出 host trust tap。
  const taps: Array<{ label: string; run: (html: string) => string }> = [];
  const effects: Array<{ label: string; dispose: () => void }> = [];
  const injectListeners: Array<(table: unknown[]) => void> = [];
  const routes: Array<{ path: string }> = [];
  let activeLabel = "";
  const scope = {
    get: () => ({ ...state }),
    watch(cb: () => void) {
      watchers.push(cb);
      return () => {};
    },
    update: async () => {},
    replace: async () => {},
  };
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: {
      port: 3080,
      register(route: { path: string }) {
        routes.push(route);
        return () => {};
      },
      tapIndex(transform: (html: string) => string) {
        taps.push({ label: activeLabel, run: transform });
        return () => {
          const at = taps.findIndex((entry) => entry.run === transform);
          if (at !== -1) taps.splice(at, 1);
        };
      },
      on(event: string, cb: (table: unknown[]) => void) {
        if (event === "webserver/index-inject") injectListeners.push(cb);
        return () => {};
      },
    },
    inject(services: string[], fn: (c: unknown) => void) {
      if (services.includes("settings")) {
        fn({
          settings: { register: () => scope, describe: () => [] },
          effect: (f: () => unknown) => f(),
        });
      }
    },
    effect(fn: () => unknown, label: string) {
      activeLabel = label;
      let d: unknown;
      try {
        d = fn();
      } finally {
        activeLabel = "";
      }
      if (typeof d === "function") effects.push({ label, dispose: d as () => void });
      return d;
    },
  };
  return { ctx, state, watchers, taps, effects, injectListeners, routes };
}

describe("apply 接线：host trust tap 的生命周期纪律", () => {
  it("跨多次 sync 只注册一次；开关逐请求读取；不污染注入表；dispose 后注入消失", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-host-trust-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    vi.useFakeTimers();
    try {
      const h = makeHostTrustCtx();
      apply(h.ctx as unknown as Context, {
        enabled: false,
        httpsEnabled: false,
        printBanner: false,
      });

      const hostTrustTaps = () => h.taps.filter((entry) => entry.label === "lan-proxy: host trust");
      const hostTrustEffects = () => h.effects.filter((e) => e.label === "lan-proxy: host trust");

      expect(hostTrustEffects().length).toBe(1);
      expect(hostTrustTaps().length).toBe(1);

      // 默认关：同一 tap 的输出逐字节不变
      const tap = hostTrustTaps()[0].run;
      expect(tap(RAW_INDEX)).toBe(RAW_INDEX);

      // 两次 sync 触发（scope.watch → 3s 防抖）：tap 数与 effect 数都不得增长
      for (const cb of h.watchers) cb();
      vi.advanceTimersByTime(3000);
      for (const cb of h.watchers) cb();
      vi.advanceTimersByTime(3000);
      expect(hostTrustTaps().length).toBe(1);
      expect(hostTrustEffects().length).toBe(1);

      // 开关按请求读取：同一个 tap 立即随配置变化（未重建）
      h.state.ownsHostCompat = true;
      expect(tap(RAW_INDEX)).toContain(HOST_TRUST_ELEMENT_ID);
      h.state.ownsHostCompat = false;
      expect(tap(RAW_INDEX)).toBe(RAW_INDEX);

      // 官方结构化注入表不被本插件写行（global 行会整体覆盖 transport）
      const table: unknown[] = [];
      for (const cb of h.injectListeners) cb(table);
      expect(table).toEqual([]);

      // dispose 后注入消失
      for (const e of [...h.effects].reverse()) {
        try {
          e.dispose();
        } catch {}
      }
      expect(hostTrustTaps().length).toBe(0);
    } finally {
      vi.useRealTimers();
      process.env.DSH_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("apply 接线：randomUUID polyfill tap（entry 段补强）", () => {
  it("head 内幂等注入且含 randomUUID 回退实现", () => {
    const home = mkdtempSync(join(tmpdir(), "dsh-lan-proxy-polyfill-"));
    const prevHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    try {
      const h = makeHostTrustCtx();
      apply(h.ctx as unknown as Context, {
        enabled: false,
        httpsEnabled: false,
        printBanner: false,
      });
      const taps = h.taps.filter((entry) => entry.label === "lan-proxy: randomUUID polyfill");
      expect(taps.length).toBe(1);
      const once = taps[0].run(RAW_INDEX);
      expect(once).toContain("__dshRandomUuidPolyfill__");
      expect(once).toContain("crypto.randomUUID");
      expect(once.indexOf("__dshRandomUuidPolyfill__")).toBeLessThan(once.indexOf("</head>"));
      expect(taps[0].run(once)).toBe(once);
    } finally {
      process.env.DSH_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
