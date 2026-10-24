/**
 * dsh-mcp-manager — integration：apply 的 settings 注入与降级面（#1174 shape 拆分产物，断言与 fullName 逐字保留）。
 *
 * 集成层（docs/ARCHITECTURE-METHOD.md §8 导入面矩阵）：矩阵把「包产物入口 + `apply()`」列为
 * 集成层的许可导入面，本文件的被测对象**就是 `apply()` 本身**——它在 src/index.ts 内就地定义
 * （包自己的架构计划「各落点域端口化之后才谈把它再拆出去」把它压在组合根里），全仓无第二出口，
 * 故单元层不存在合法导入面。断言与其夹具自原 apply-lifecycle.test.ts 逐字迁来，未改判据。
 *
 * 覆盖：apply 经 ctx.inject(["settings"]) 的全部读写：canonical ns 读、POST /config 写、uiUpdate 懒写入、describe 抛错 / 缺 register 静默降级、document-updated 订阅与 disposer、卸载态短路。
 */
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { callHandler, fakeRes } from "../helpers.ts";
import { baseCtx, makeTempDir, releaseTempDirs } from "./remaining-apply-support.ts";

// apply 是组合根内就地定义、单元层无合法导入面的符号——本层经包入口取它
// （§8 矩阵：包产物入口是集成层的许可导入面）。
const { apply } = await import("../../src/index.ts");
const { ROUTES } = await import("../../src/server/api/interface.ts");
const { MCP_MANAGER_IDENTITY } = await import("../../src/shared/interface.ts");

afterEach(() => {
  releaseTempDirs();
});

describe("apply 的 settings 注入（uiUpdate 写入路径）", () => {
  type CapturedRoute = {
    path: string;
    handler: (req: IncomingMessage, res: ReturnType<typeof fakeRes>) => unknown;
  };

  const configRequest = (method: string, body?: unknown): IncomingMessage =>
    ({
      method,
      url: ROUTES.config,
      socket: { remoteAddress: "127.0.0.1" },
      headers: {
        host: "localhost:3080",
        origin: "http://localhost:3080",
        "sec-fetch-site": "same-origin",
      },
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) {
          yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
        }
      },
      on: () => {},
    }) as unknown as IncomingMessage;

  async function applyWithSettings() {
    const dir = makeTempDir("dsh-mcp-manager-ui-");
    const routes: CapturedRoute[] = [];
    const refs: {
      updateCalled: boolean;
      updateNs: unknown;
      updatePatch: unknown;
      describeCalled: boolean;
    } = { updateCalled: false, updateNs: null, updatePatch: null, describeCalled: false };

    const ctx = baseCtx({
      webServer: {
        register: (route: CapturedRoute) => {
          routes.push(route);
          return () => {};
        },
      },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              update: function (ns: unknown, patch: unknown) {
                refs.updateCalled = true;
                refs.updateNs = ns;
                refs.updatePatch = patch;
                return Promise.resolve();
              },
              describe: () => {
                refs.describeCalled = true;
                return [
                  {
                    ns: "dsh-mcp-manager",
                    value: {
                      ui: {
                        position: "bottom-right",
                        offset: { x: 91, y: 92, blankY: 93 },
                        zIndexBase: 901,
                      },
                    },
                    revision: 0,
                  },
                ];
              },
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
    });

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    const configRoute = routes.find((route) => route.path === ROUTES.config);
    if (configRoute === undefined) throw new Error("config route was not registered");
    return { refs, configRoute };
  }

  it("从 host 的 canonical settings namespace 读取 UI 配置", async () => {
    const { configRoute, refs } = await applyWithSettings();
    expect(refs.describeCalled).toBe(true);
    const response = await callHandler(configRoute, configRequest("GET"));
    expect(response.payload).toEqual({
      position: "bottom-right",
      offsetX: 91,
      offsetY: 92,
      blankY: 93,
      zIndexBase: 901,
    });
  });

  it("POST /config 只向 canonical settings namespace 写入", async () => {
    const { configRoute, refs } = await applyWithSettings();
    const response = await callHandler(
      configRoute,
      configRequest("POST", { position: "bottom-left", offsetX: 4 }),
    );
    expect(response.status).toBe(200);
    expect(refs.updateCalled).toBe(true);
    expect(refs.updateNs).toBe(MCP_MANAGER_IDENTITY.settingsNamespace);
    expect(refs.updatePatch).toEqual({
      ui: {
        position: "bottom-left",
        offset: { x: 4, y: 8, blankY: 40 },
        zIndexBase: 10,
      },
    });
  });

  it("uiUpdate 懒写入：apply 时不触发", async () => {
    const { refs } = await applyWithSettings();
    expect(refs.updateCalled).toBe(false);
  });
});

describe("通过 apply 间接覆盖 installSettingsNamespace 降级分支", () => {
  it("ctx.inject 不可用时静默降级（不抛）", async () => {
    // 通过 fakeCtx 模拟 apply 的 settings 注入路径
    // 覆盖 installSettingsNamespace 的 ctx.inject 不可用分支
    // 故意缺 inject 方法的残缺宿主：apply 必须静默降级。残缺形状按接缝收窄（运行时原样传入）。
    const noInjectCtx = {
      logger: { warn: () => {} },
      // 没有 inject 方法
      effect: () => () => {},
      on: () => () => {},
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    };
    const dir = makeTempDir("dsh-mcp-manager-ni-");
    await expect(
      apply(noInjectCtx as unknown as Context, {
        enabled: false,
        storePath: join(dir, "mcp.json"),
      }),
    ).resolves.toBeUndefined();
  });

  it("settings.describe 抛错时降级（不抛）", async () => {
    // settings 服务存在但 describe 抛错 → 回落 entry
    const failSettingsCtx = {
      logger: { warn: () => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              describe: () => {
                throw new Error("describe failed");
              },
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
      effect: () => () => {},
      on: () => () => {},
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    };
    const dir = makeTempDir("dsh-mcp-manager-sf-");
    await expect(
      apply(failSettingsCtx as unknown as Context, {
        enabled: false,
        storePath: join(dir, "mcp.json"),
      }),
    ).resolves.toBeUndefined();
  });

  it("settings 缺少 register 时降级（不抛）", async () => {
    // settings 服务存在但 register 不是函数
    const noRegCtx = {
      logger: { warn: () => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {},
            effect: () => () => {},
          });
        }
        return () => {};
      },
      effect: () => () => {},
      on: () => () => {},
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    };
    const dir = makeTempDir("dsh-mcp-manager-nr-");
    await expect(
      apply(noRegCtx as unknown as Context, { enabled: false, storePath: join(dir, "mcp.json") }),
    ).resolves.toBeUndefined();
  });
});

describe("apply 的 settings 注入（uiUpdate 写入路径）", () => {
  it("settings 命名空间接线（inject settings 装配面）", async () => {
    const dir = makeTempDir("dsh-mcp-manager-ui2-");
    let describeCalled = false;
    const ctx = {
      fiber: { state: "active" },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              update: function (_ns: unknown, _patch: unknown) {
                return Promise.resolve();
              },
              describe: () => {
                describeCalled = true;
                return [];
              },
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
      on: () => () => {},
      effect: (fn: () => () => void) => {
        const d = fn();
        return () => {
          d();
        };
      },
    };

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    // 哑断言清理（#664 阶段 8）：假 ok 输出改真实断言——settings 命名空间
    // 接线（installSettingsNamespace 经 inject(["settings"]) 调 describe）。
    expect(describeCalled).toBeTruthy();
  });
});

describe("apply 完整 settings 生命周期（isUnloading 覆盖）", () => {
  async function applyWithSettingsLifecycle() {
    const dir = makeTempDir("dsh-mcp-manager-bundled-");
    const refs: { disposer: null | (() => void); emit: null | ((ns: string) => void) } = {
      disposer: null,
      emit: null,
    };

    const ctx = {
      fiber: { state: "active" },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      inject: (keys: unknown, cb: (services: unknown) => void) => {
        if (Array.isArray(keys) && keys.includes("settings")) {
          cb({
            settings: {
              describe: () => [
                {
                  ns: MCP_MANAGER_IDENTITY.settingsNamespace,
                  value: {
                    ui: { position: "top-right", offset: { x: 8, y: 8, blankY: 40 } },
                  },
                  revision: 0,
                },
              ],
            },
            effect: (fn: () => () => void) => {
              refs.disposer = fn();
              return () => {};
            },
            on: (event: string, cb2: (ns: string, revision: number) => void) => {
              if (event !== "settings/document-updated") throw new Error("unexpected event");
              refs.emit = (ns: string) => cb2(ns, 1);
              return () => {
                refs.emit = null;
              };
            },
          });
        }
        return () => {};
      },
      on: () => () => {},
      effect: (fn: () => () => void) => {
        const d = fn();
        return () => {
          d();
        };
      },
    };

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    return { ctx, refs };
  }

  it("effect disposer 已注册", async () => {
    const { refs } = await applyWithSettingsLifecycle();
    expect(refs.disposer).not.toBeNull();
  });

  it("内部订阅已接线（settings 装配面）", async () => {
    const { refs } = await applyWithSettingsLifecycle();
    expect(refs.emit).not.toBeNull();
  });

  // 哑断言清理（#664 阶段 8）：isUnloading 短路（unloading/disposed 态
  // 订阅/disposer 不触发 onChange）由 shared/settings-namespace.js 自身
  // 单测覆盖——此处保留卸载路径执行冒烟（不抛）。
  it("卸载态 disposer/订阅执行不抛", async () => {
    const { ctx, refs } = await applyWithSettingsLifecycle();
    const emit = refs.emit!;
    expect(() => {
      ctx.fiber.state = "unloading";
      refs.disposer!();
      ctx.fiber.state = "disposed";
      emit(MCP_MANAGER_IDENTITY.settingsNamespace);
    }).not.toThrow();
  });
});
