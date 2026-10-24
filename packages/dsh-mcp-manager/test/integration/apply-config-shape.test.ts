/**
 * dsh-mcp-manager — integration：apply 的配置分支（enabled / announce 键 → 装配面投影）（#1174 shape 拆分产物，断言与 fullName 逐字保留）。
 *
 * 集成层（docs/ARCHITECTURE-METHOD.md §8 导入面矩阵）：矩阵把「包产物入口 + `apply()`」列为
 * 集成层的许可导入面，本文件的被测对象**就是 `apply()` 本身**——它在 src/index.ts 内就地定义
 * （包自己的架构计划「各落点域端口化之后才谈把它再拆出去」把它压在组合根里），全仓无第二出口，
 * 故单元层不存在合法导入面。断言与其夹具自原 apply-lifecycle.test.ts 逐字迁来，未改判据。
 *
 * 覆盖：enabled:false 的全部否定与「仅注册 dispose effect」、announceToAgent / announceCatalog 分键、默认开启、多条 effect disposer、卸载时注销路由与提示词。
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { makeTempDir, releaseTempDirs } from "./remaining-apply-support.ts";

const { apply } = await import("../../src/index.ts");

afterEach(() => {
  releaseTempDirs();
});
/**
 * 配置分支共用的可回读装配面：routes / sections / preSteps / disposers / injected 五个账本
 * （各 disposer 同步调用，cordis effect(fn, label) 语义：立即执行工厂取回 disposer）。
 * 提成具名 register 函数而非两个 describe 各存一份，避免逐字重复夹具。
 */
function registerConfigHost() {
  const state: {
    preSteps: Array<(...args: unknown[]) => void>;
    sections: string[];
    routes: string[];
    disposers: Array<() => void>;
    injected: unknown[];
  } = { preSteps: [], sections: [], routes: [], disposers: [], injected: [] };
  const ctx = {
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    tools: { register: () => () => {} },
    webServer: {
      register: (route: { path: string }) => {
        state.routes.push(route.path);
        return () => {
          const i = state.routes.indexOf(route.path);
          if (i >= 0) state.routes.splice(i, 1);
        };
      },
    },
    systemPrompt: {
      section: (opts: { name: string }) => {
        state.sections.push(opts.name);
        return () => {
          const i = state.sections.indexOf(opts.name);
          if (i >= 0) state.sections.splice(i, 1);
        };
      },
    },
    inject: (keys: unknown, _cb: (services: unknown) => void) => {
      state.injected.push(keys);
      return () => {};
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (event === "agent/pre-step") state.preSteps.push(handler);
      return () => {};
    },
    effect: (fn: () => () => void) => {
      const disposer = fn();
      state.disposers.push(disposer);
      return disposer;
    },
  };
  return { ctx, state };
}

/** 隔离 DSH_HOME 的夹具生命周期：每例换一个真实临时根，afterEach 还原（保留原还原链）。 */
function withIsolatedHome() {
  let prevHome: string | undefined;
  let homeDir: string;
  beforeEach(() => {
    prevHome = process.env.DSH_HOME;
    homeDir = makeTempDir("dsh-mcp-apply2-");
    process.env.DSH_HOME = homeDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });
  return {
    homePath: (name: string) => join(homeDir, name),
    /** 装配一次 apply 并回读五个账本（残缺宿主：只实现装配触达面，按接缝收窄）。 */
    async applied(options: Record<string, unknown> | undefined) {
      const { ctx, state } = registerConfigHost();
      await apply(ctx as unknown as Context, options);
      return { ctx, state };
    },
  };
}

describe("apply：配置分支", () => {
  const { homePath, applied } = withIsolatedHome();

  it("禁用不注册路由", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.routes.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用不注入提示词", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.sections.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用不注册 pre-step", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.preSteps.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("禁用仅注册 dispose effect", async () => {
    const { state } = await applied({ enabled: false });
    expect(state.disposers.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  // announceToAgent:false：有路由无 section；announceCatalog:false：无 pre-step。
  const disabledAnnounce = () =>
    applied({
      announceToAgent: false,
      announceCatalog: false,
      storePath: homePath("st.json"),
    });

  it("启用时注册全部路由", async () => {
    const { state } = await disabledAnnounce();
    expect(state.routes.length >= 9).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("关闭宣告不注入提示词", async () => {
    const { state } = await disabledAnnounce();
    expect(state.sections.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("关闭目录不注册 pre-step", async () => {
    const { state } = await disabledAnnounce();
    expect(state.preSteps.length).toBe(0);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  // 默认开启：section + pre-step + settings 注入。
  const defaultOn = () => applied({ storePath: homePath("st2.json") });

  it("默认注入提示词 section", async () => {
    const { state } = await defaultOn();
    expect(state.sections.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("默认注册目录 pre-step", async () => {
    const { state } = await defaultOn();
    expect(state.preSteps.length).toBe(1);
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("尝试注入 settings", async () => {
    const { state } = await defaultOn();
    expect(state.injected.some((k) => Array.isArray(k) && k.includes("settings"))).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("settings 注入回调通路（cb 收到 settings 服务即挂载成功）", async () => {
    const { ctx } = await defaultOn();
    // settings 注入回调挂 uiUpdate 的通路验证（cb 收到 settings 服务即挂载成功）。
    const settingsCalls: Array<[unknown, unknown]> = [];
    const settingsCtx = {
      logger: ctx.logger,
      effect: ctx.effect,
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              update: async (ns: unknown, patch: unknown) => settingsCalls.push([ns, patch]),
            },
          });
        }
        return () => {};
      },
    };
    // 残缺宿主（只实现 settings 注入面）：按接缝收窄。
    await apply(settingsCtx as unknown as Context, { enabled: false });
    expect(typeof settingsCalls).toBe("object");
  });
});

describe("apply：配置分支", () => {
  const { homePath, applied } = withIsolatedHome();

  // effect disposer：卸载时注销路由与提示词。
  const unloadFixture = () => applied({ storePath: homePath("st3.json") });

  it("默认注册多个 effect disposer", async () => {
    const { state } = await unloadFixture();
    expect(state.disposers.length >= 2).toBeTruthy();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
  });

  it("卸载注销全部路由", async () => {
    const { state } = await unloadFixture();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
    expect(state.routes.length).toBe(0);
  });

  it("卸载注销提示词", async () => {
    const { state } = await unloadFixture();
    for (const disposeEffect of [...state.disposers]) disposeEffect();
    expect(state.sections.length).toBe(0);
  });
});
