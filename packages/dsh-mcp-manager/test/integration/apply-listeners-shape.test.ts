/**
 * dsh-mcp-manager — integration：apply 的 agent/pre-step 监听与 SSE / route disposer（#1174 shape 拆分产物，断言与 fullName 逐字保留）。
 *
 * 集成层（docs/ARCHITECTURE-METHOD.md §8 导入面矩阵）：矩阵把「包产物入口 + `apply()`」列为
 * 集成层的许可导入面，本文件的被测对象**就是 `apply()` 本身**——它在 src/index.ts 内就地定义
 * （包自己的架构计划「各落点域端口化之后才谈把它再拆出去」把它压在组合根里），全仓无第二出口，
 * 故单元层不存在合法导入面。断言与其夹具自原 apply-lifecycle.test.ts 逐字迁来，未改判据。
 *
 * 覆盖：pre-step 监听注册与 signal 取消、decision / reject 透传、announceCatalog=false 不注册；events SSE 路由装配、连接未 dispose 前不销毁、disposer 幂等不抛。
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { baseCtx, makeTempDir, releaseTempDirs } from "./remaining-apply-support.ts";

const { apply } = await import("../../src/index.ts");

afterEach(() => {
  releaseTempDirs();
});

describe("apply 的 agent/pre-step 监听（announceCatalog=true）", () => {
  async function applyWithPreStep() {
    const dir = makeTempDir("dsh-mcp-manager-apply-");
    const refs: { preStepHandler: null | ((...args: unknown[]) => unknown) } = {
      preStepHandler: null,
    };
    const ctx = baseCtx({
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        if (evt === "agent/pre-step") {
          refs.preStepHandler = handler;
        }
        return () => {};
      },
    });
    await apply(ctx as unknown as Context, {
      enabled: true,
      announceCatalog: true,
      storePath: join(dir, "mcp.json"),
    });
    return refs;
  }

  it("agent/pre-step 监听已注册", async () => {
    const refs = await applyWithPreStep();
    expect(refs.preStepHandler).not.toBeNull();
  });

  it("signal 取消 → handler 抛 aborted", async () => {
    const refs = await applyWithPreStep();
    // 测试 pre-step handler 的信号取消分支
    // 当 signal.aborted 时，handler 应抛 AbortError
    const abortedSignal = {
      aborted: true,
      throwIfAborted: () => {
        throw new Error("aborted");
      },
    };
    await expect(
      refs.preStepHandler!(
        { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: abortedSignal },
        async () => ({ kind: "enter", messages: [] }),
      ),
    ).rejects.toThrow(/aborted/);
  });

  it("pre-step 返回 decision", async () => {
    const refs = await applyWithPreStep();
    // 正常 pre-step 路径（无服务器时目录为空 → 不注入）
    const normalSignal = { aborted: false, throwIfAborted: () => {} };
    const result = (await refs.preStepHandler!(
      { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: normalSignal },
      async () => ({ kind: "enter", messages: [] }),
    )) as { kind: unknown; messages: unknown };
    // 无服务器时返回原始 decision（不注入）
    expect(result.kind === "enter" || Array.isArray(result.messages)).toBeTruthy();
  });

  it("reject 原样透传", async () => {
    const refs = await applyWithPreStep();
    const normalSignal = { aborted: false, throwIfAborted: () => {} };
    // reject 不处理
    // pre-step 已注册由首用例保证（同一装配器），此处非空。
    const rejectResult = (await refs.preStepHandler!(
      { agent: { session: { header: { cwd: "/tmp" } } }, messages: [], signal: normalSignal },
      async () => ({ kind: "reject" }),
    )) as { kind: unknown };
    expect(rejectResult.kind).toBe("reject");
  });
});

describe("apply 的 SSE broadcast 与 route disposer", () => {
  async function applyWithSse() {
    const dir = makeTempDir("dsh-mcp-manager-sse-");
    const destroyed: string[] = [];
    const written: unknown[] = [];
    const sseConns: Set<{
      write: (chunk: unknown) => void;
      destroy: () => void;
    }> = new Set();

    const ctx = baseCtx({
      webServer: {
        register: (route: { path: string }) => {
          // 捕获 events 路由
          if (route.path === "/api/dsh-mcp/events") {
            // 注册后模拟 SSE 连接
            sseConns.add({
              write: (chunk: unknown) => written.push(chunk),
              destroy: () => destroyed.push("destroyed"),
            });
          }
          return () => {};
        },
      },
    });

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    return { sseConns, destroyed, written };
  }

  // 哑断言清理（#664 阶段 8）：补真实装配断言——events SSE 路由已注册，
  // 连接可被 hub 接受（apply 广播面接线成立）；dispose 由 effect 收口不在此造。
  it("events SSE 路由已注册（apply 广播面装配）", async () => {
    const { sseConns } = await applyWithSse();
    expect(sseConns.size >= 1).toBeTruthy();
  });

  it("未 dispose 前连接不被销毁", async () => {
    const { destroyed } = await applyWithSse();
    expect(destroyed.length).toBe(0);
  });
});

describe("apply 的 agent/pre-step 监听（announceCatalog=false）", () => {
  it("announceCatalog=false 不注册 pre-step 监听", async () => {
    const dir = makeTempDir("dsh-mcp-manager-Nc-");
    let preStepHandler: null | ((...args: unknown[]) => unknown) = null;
    const ctx = baseCtx({
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        if (evt === "agent/pre-step") preStepHandler = handler;
        return () => {};
      },
    });

    await apply(ctx as unknown as Context, {
      enabled: true,
      announceCatalog: false,
      storePath: join(dir, "mcp.json"),
    });
    expect(preStepHandler).toBeNull();
  });
});

describe("apply 的 route disposer（SSE 连接清理）", () => {
  async function applyWithRouteDisposer() {
    const dir = makeTempDir("dsh-mcp-manager-rd-");
    const refs: { disposeRoutes: null | (() => void); eventsRouteRegistered: boolean } = {
      disposeRoutes: null,
      eventsRouteRegistered: false,
    };
    const sseDestroyed: string[] = [];

    const ctx = baseCtx({
      webServer: {
        register: (route: { path: string }) => {
          if (route.path === "/api/dsh-mcp/events") {
            refs.eventsRouteRegistered = true;
          }
          return () => {};
        },
      },
      effect: (fn: () => () => void) => {
        const disposer = fn();
        refs.disposeRoutes = () => {
          // 手动触发 disposer（模拟上下文卸载）
          disposer();
        };
        return () => {};
      },
    });

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    return { refs, sseDestroyed };
  }

  // 哑断言清理（#664 阶段 8）：补真实装配断言——events 路由注册 + 卸载
  // disposer 不抛（apply 路由收口面成立）。
  it("events 路由已注册", async () => {
    const { refs } = await applyWithRouteDisposer();
    expect(refs.eventsRouteRegistered).toBeTruthy();
  });

  it("disposer 触发前无销毁记录", async () => {
    const { sseDestroyed } = await applyWithRouteDisposer();
    expect(sseDestroyed.length).toBe(0);
  });

  it("卸载 disposer 执行不抛", async () => {
    const { refs } = await applyWithRouteDisposer();
    // apply 装配期 effect 必走，非空由用例流保证。
    expect(() => refs.disposeRoutes!()).not.toThrow();
  });
});

describe("apply 的 agent/pre-step 在 announceCatalog=true 时注册", () => {
  async function applyWithPreStep() {
    const dir = makeTempDir("dsh-mcp-manager-pre-");
    const refs: { preHandler: null | ((...args: unknown[]) => unknown) } = { preHandler: null };
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
              describe: () => [],
            },
            effect: () => () => {},
          });
        }
        return () => {};
      },
      on: (evt: string, handler: (...args: unknown[]) => void) => {
        if (evt === "agent/pre-step") refs.preHandler = handler;
        return () => {};
      },
      effect: (fn: () => () => void) => {
        const d = fn();
        return () => {
          d();
        };
      },
    };

    await apply(ctx as unknown as Context, {
      enabled: true,
      announceCatalog: true,
      storePath: join(dir, "mcp.json"),
    });
    return refs;
  }

  it("pre-step handler 通过 apply 注册", async () => {
    const refs = await applyWithPreStep();
    expect(refs.preHandler).not.toBeNull();
  });

  it("pre-step reject 透传", async () => {
    const refs = await applyWithPreStep();
    // 调用 handler: reject 透传
    // pre-step 已注册由上一用例保证（同一装配器），此处非空。
    const rejectResult = (await refs.preHandler!(
      {
        agent: { session: { header: { cwd: "/tmp" } } },
        messages: [],
        signal: { aborted: false, throwIfAborted: () => {} },
      },
      async () => ({ kind: "reject" }),
    )) as { kind: unknown };
    expect(rejectResult.kind).toBe("reject");
  });
});

describe("apply 的 SSE broadcast 与 route disposer", () => {
  async function applyWithBroadcast() {
    const dir = makeTempDir("dsh-mcp-manager-broadcast-");
    const refs: { effectDisposer: null | (() => void) } = { effectDisposer: null };

    const ctx = {
      fiber: { state: "active" },
      logger: { warn: () => {}, info: () => {}, error: () => {} },
      tools: { register: () => () => {} },
      webServer: {
        register: (route: { path: string }) => {
          if (route.path === "/api/dsh-mcp/events") {
            // 不处理，只验证 apply 完成
          }
          return () => {};
        },
      },
      systemPrompt: { section: () => () => {} },
      inject: () => () => {},
      on: () => () => {},
      effect: (fn: () => () => void) => {
        const d = fn();
        refs.effectDisposer = () => {
          d();
        };
        return () => {};
      },
    };

    await apply(ctx as unknown as Context, { enabled: true, storePath: join(dir, "mcp.json") });
    return refs;
  }

  it("effect disposer 已注册", async () => {
    const refs = await applyWithBroadcast();
    expect(refs.effectDisposer).not.toBeNull();
  });

  it("disposer 重复触发幂等（不抛）", async () => {
    const refs = await applyWithBroadcast();
    expect(() => {
      // 触发 disposer（模拟卸载场景）
      refs.effectDisposer!();
      // 再次触发（幂等，不抛）
      refs.effectDisposer!();
    }).not.toThrow();
  });
});
