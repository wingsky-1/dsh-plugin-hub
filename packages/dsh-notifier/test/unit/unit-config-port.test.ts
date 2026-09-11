/**
 * dsh-notifier — L2 interface 契约：ConfigPort 降级语义 + 路由错误映射直测
 * （契约面直测；工厂与路由 handler 均经 fake deps 驱动）。
 *
 * ConfigPort 契约经 settings-bridge 实现面直测——
 * 未 attach 降级（readUser→{user:{},revision:undefined}、writable→false、
 * update/confirmKind→reject SETTINGS_UNAVAILABLE）；resolve 是 getCurrent 别名；
 * confirmKind CAS 重试 ≤2（SETTINGS_CONFLICT 回读重试、耗尽 reject，行为复用
 * 现状 confirmKindToConfig 实现）。
 * applyConfigPatch 纯函数直测（deps fake）——expectedRevision 非
 * 「非负整数或省略」→ 400 显式拒；省略/null → undefined 透传。
 * buildRoutes fake deps 直测 handler——history.clear() 抛错 → 500 固定
 * 文案（不再恒 200）；成功仍 200 {ok:true, removed}。
 *
 * 标准红测判别：ConfigPort 类型 / 400 分支 / 500 分支落地前，本文件对应断言红
 * （改前红），实现落地后全绿（改后绿）。直测 src 域 interface.ts。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { applyConfigPatch, buildRoutes, ROUTES } from "../../src/server/interface.ts";
import type { RouteDeps } from "../../src/server/interface.ts";
import { createSettingsBridge } from "../../src/config/interface.ts";
import type { NotifyConfig } from "../../src/config/interface.ts";
import { fakeReq, makeFakeCtx, makeFakeSettings, makeRes } from "../helpers.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-unit-config-port-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** applyConfigPatch 直测用 fake deps（记录 update 调用）。 */
function makeDeps(): { updates: Array<{ patch: object; expectedRevision?: number }>; deps: RouteDeps } {
  const updates: Array<{ patch: object; expectedRevision?: number }> = [];
  return {
    updates,
    deps: {
      resolve: () => ({}) as unknown as NotifyConfig,
      readUser: () => ({ user: {}, revision: 0 }),
      writable: () => true,
      update(patch, expectedRevision) {
        updates.push({ patch, expectedRevision });
        return Promise.resolve();
      },
      confirmKind: () => Promise.resolve(),
      logger: { warn: () => {}, info: () => {} },
      sse: {} as unknown as RouteDeps["sse"],
      system: {} as unknown as RouteDeps["system"],
      history: {} as unknown as RouteDeps["history"],
      sendTest: () => [],
      statusReader: async () => ({}),
      listKinds: () => [],
    },
  };
}

/** 失败分支读面（response 仅在 ok:false 分支存在）。 */
function failResponse(result: Awaited<ReturnType<typeof applyConfigPatch>>): Record<string, unknown> {
  if (result.ok) throw new Error("预期失败分支，但 applyConfigPatch 返回成功");
  return result.response;
}

/** history DELETE 直测用 fake deps（注入 clear 实现）。 */
function makeHistoryDeps(clearImpl: () => Promise<number>): { route: WebRoute; warns: string[] } {
  const warns: string[] = [];
  const deps: RouteDeps = {
    resolve: () => ({}) as unknown as NotifyConfig,
    readUser: () => ({ user: {}, revision: 0 }),
    writable: () => true,
    update: () => Promise.resolve(),
    confirmKind: () => Promise.resolve(),
    logger: { warn: (m) => warns.push(m), info: () => {} },
    sse: {} as unknown as RouteDeps["sse"],
    system: {} as unknown as RouteDeps["system"],
    history: { read: async () => [], clear: clearImpl } as unknown as RouteDeps["history"],
    sendTest: () => [],
    statusReader: async () => ({}),
    listKinds: () => [],
  };
  const routes = buildRoutes(deps);
  return { route: routes.find((r) => r.path === ROUTES.history) as WebRoute, warns };
}

/** 触发 DELETE /history 并回收响应。 */
async function deleteHistory(clearImpl: () => Promise<number>) {
  const { route, warns } = makeHistoryDeps(clearImpl);
  const { rec, res } = makeRes();
  await route.handler(fakeReq({ method: "DELETE" }) as unknown as IncomingMessage, res as unknown as ServerResponse);
  return { rec, warns };
}

describe("ConfigPort 降级语义（未 attach settings）", () => {
  let bridge: ReturnType<typeof createSettingsBridge>;

  beforeEach(() => {
    const { ctx } = makeFakeCtx({}); // 未 provide settings
    bridge = createSettingsBridge(ctx, { configFile: join(work, "a.json") });
  });

  it("未 attach readUser 降级 {user:{},revision:undefined}", () => {
    expect(bridge.readUser()).toEqual({ user: {}, revision: undefined });
  });

  it("未 attach writable=false（降级）", () => {
    expect(bridge.writable()).toBe(false);
  });

  it("未 attach update 直拒 SETTINGS_UNAVAILABLE", async () => {
    let rejected: { code?: string } | null = null;
    try {
      await bridge.update({ maxConnections: 8 });
    } catch (err) {
      rejected = err as { code?: string };
    }
    expect(rejected?.code).toBe("SETTINGS_UNAVAILABLE");
  });

  it("未 attach confirmKind 直拒 SETTINGS_UNAVAILABLE", async () => {
    let rejected: { code?: string } | null = null;
    try {
      await bridge.confirmKind("ext:alpha", true);
    } catch (err) {
      rejected = err as { code?: string };
    }
    expect(rejected?.code).toBe("SETTINGS_UNAVAILABLE");
  });
});

describe("attach 态 ConfigPort 面（resolve 别名 / readUser / writable / update / confirmKind）", () => {
  let bridge: ReturnType<typeof createSettingsBridge>;
  let fakeSettings: ReturnType<typeof makeFakeSettings>;

  beforeEach(() => {
    // fake settings 的 register 忽略 opts.base：attach 后 source 取 makeFakeSettings
    // 的 base（组合层 entry 的等价注入位——routes.test.ts 同构写法）。
    fakeSettings = makeFakeSettings({ base: { maxConnections: 42 } });
    const { ctx } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    bridge = createSettingsBridge(ctx, { configFile: join(work, "b.json") });
  });

  it("resolve 读取 current（getCurrent 别名）", () => {
    expect(bridge.resolve().maxConnections).toBe(42);
  });

  it("resolve 与 getCurrent 同值同引用（别名语义）", () => {
    expect(bridge.resolve()).toBe(bridge.getCurrent());
  });

  it("attach 态 writable=true", () => {
    expect(bridge.writable()).toBe(true);
  });

  it("update 写 settings user 层", async () => {
    await bridge.update({ notifyAsk: false });
    expect(fakeSettings.getUser().notifyAsk).toBe(false);
  });

  it("confirmKind 写 allowKinds（CAS 语义）", async () => {
    await bridge.confirmKind("ext:beta", true);
    expect(fakeSettings.getUser().allowKinds.includes("ext:beta")).toBeTruthy();
  });

  it("confirmKind 撤销从 allowKinds 删除", async () => {
    await bridge.confirmKind("ext:beta", true);
    await bridge.confirmKind("ext:beta", false);
    expect(fakeSettings.getUser().allowKinds.includes("ext:beta")).toBe(false);
  });
});

describe("confirmKind CAS 冲突重试 ≤2——首次冲突回读重试成功", () => {
  let bridge: ReturnType<typeof createSettingsBridge>;
  let conflictCalls: number;

  beforeEach(async () => {
    const fakeSettings = makeFakeSettings({ base: {} });
    const { ctx } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    bridge = createSettingsBridge(ctx, { configFile: join(work, "c.json") });
    const origUpdate = fakeSettings.service.update;
    let conflictOnce = true;
    conflictCalls = 0;
    fakeSettings.service.update = async (ns, patch, expectedRevision) => {
      if (conflictOnce) {
        conflictOnce = false;
        conflictCalls += 1;
        throw Object.assign(new Error("settings conflict"), { code: "SETTINGS_CONFLICT" });
      }
      return origUpdate(ns, patch, expectedRevision);
    };
    await bridge.confirmKind("ext:gamma", true);
  });

  it("第一次 update 触发 SETTINGS_CONFLICT", () => {
    expect(conflictCalls).toBe(1);
  });

  it("冲突回读重试后确认态落盘", () => {
    expect((bridge.readUser().user.allowKinds as string[]).includes("ext:gamma")).toBeTruthy();
  });
});

describe("confirmKind CAS 耗尽（恒冲突）→ 尝试 = 首次 + 重试 ≤2 = 3 次 reject", () => {
  let conflictCalls: number;
  let rejected: { code?: string } | null;

  beforeEach(async () => {
    const fakeSettings = makeFakeSettings({ base: {} });
    const { ctx } = makeFakeCtx({});
    ctx.provide("settings", fakeSettings.service);
    const bridge = createSettingsBridge(ctx, { configFile: join(work, "d.json") });
    conflictCalls = 0;
    rejected = null;
    fakeSettings.service.update = async () => {
      conflictCalls += 1;
      throw Object.assign(new Error("settings conflict"), { code: "SETTINGS_CONFLICT" });
    };
    try {
      await bridge.confirmKind("ext:delta", true);
    } catch (err) {
      rejected = err as { code?: string };
    }
  });

  it("冲突耗尽后 reject SETTINGS_CONFLICT", () => {
    expect(rejected?.code).toBe("SETTINGS_CONFLICT");
  });

  it("CAS 尝试 = 首次 + 重试 ≤2 = 3 次后放弃", () => {
    expect(conflictCalls).toBe(3);
  });
});

for (const bad of ["abc", 1.5, -1] as const) {
  describe(`expectedRevision=${JSON.stringify(bad)} → 400（applyConfigPatch 纯函数直测）`, () => {
    let r: Awaited<ReturnType<typeof applyConfigPatch>>;
    let updates: Array<{ patch: object; expectedRevision?: number }>;

    beforeAll(async () => {
      const made = makeDeps();
      updates = made.updates;
      r = await applyConfigPatch(made.deps, { patch: { notifyAsk: false }, expectedRevision: bad });
    });

    it("非非负整数 → 400 invalid", () => {
      expect(!r.ok && r.status === 400 && r.code === "invalid").toBeTruthy();
    });

    it("400 指明 expectedRevision 键", () => {
      expect(String(failResponse(r).error)).toMatch(/expectedRevision/);
    });

    it("400 hint 说明必须为非负整数或省略", () => {
      expect(String(failResponse(r).hint)).toMatch(/非负整数/);
    });

    it("400 拒绝不触发 update", () => {
      expect(updates.length).toBe(0);
    });
  });
}

describe("expectedRevision 省略 / null / 合法值 → 透传与保存", () => {
  it("省略 expectedRevision 正常保存", async () => {
    const { deps } = makeDeps();
    const r1 = await applyConfigPatch(deps, { patch: { notifyAsk: false } });
    expect(r1.ok).toBeTruthy();
  });

  it("省略 → undefined 透传", async () => {
    const { deps, updates } = makeDeps();
    await applyConfigPatch(deps, { patch: { notifyAsk: false } });
    expect(updates[0].expectedRevision).toBe(undefined);
  });

  it("null expectedRevision 同省略（undefined 透传）", async () => {
    const { deps } = makeDeps();
    const r2 = await applyConfigPatch(deps, { patch: { notifyAsk: false }, expectedRevision: null });
    expect(r2.ok).toBeTruthy();
  });

  it("null → undefined 透传", async () => {
    const { deps, updates } = makeDeps();
    await applyConfigPatch(deps, { patch: { notifyAsk: false }, expectedRevision: null });
    expect(updates[0].expectedRevision).toBe(undefined);
  });

  it("合法非负整数正常保存", async () => {
    const { deps } = makeDeps();
    const r3 = await applyConfigPatch(deps, { patch: { notifyAsk: false }, expectedRevision: 7 });
    expect(r3.ok).toBeTruthy();
  });

  it("合法 expectedRevision 原样传给 update", async () => {
    const { deps, updates } = makeDeps();
    await applyConfigPatch(deps, { patch: { notifyAsk: false }, expectedRevision: 7 });
    expect(updates[0].expectedRevision).toBe(7);
  });
});

describe("history DELETE 失败 → 500 固定文案（buildRoutes fake deps 直测 handler）", () => {
  it("clear 失败 → 500（不再恒 200）", async () => {
    const { rec } = await deleteHistory(async () => {
      throw new Error("secret-lib-path /var/boom");
    });
    expect(rec.status).toBe(500);
  });

  it("失败响应体 ok=false", async () => {
    const { rec } = await deleteHistory(async () => {
      throw new Error("secret-lib-path /var/boom");
    });
    expect(JSON.parse(rec.text).ok).toBe(false);
  });

  it("500 固定文案「历史清空失败」", async () => {
    const { rec } = await deleteHistory(async () => {
      throw new Error("secret-lib-path /var/boom");
    });
    expect(JSON.parse(rec.text).error.error).toMatch(/历史清空失败/);
  });

  it("异常原文不进响应（P2-2 风格）", async () => {
    const { rec } = await deleteHistory(async () => {
      throw new Error("secret-lib-path /var/boom");
    });
    expect(!rec.text.includes("secret-lib-path")).toBeTruthy();
  });

  it("异常原文进服务端日志", async () => {
    const { warns } = await deleteHistory(async () => {
      throw new Error("secret-lib-path /var/boom");
    });
    expect(warns.some((w) => w.includes("secret-lib-path"))).toBeTruthy();
  });

  it("clear 成功仍 200", async () => {
    const { rec } = await deleteHistory(async () => 3);
    expect(rec.status).toBe(200);
  });

  it("成功响应 {ok:true, removed}", async () => {
    const { rec } = await deleteHistory(async () => 3);
    expect(JSON.parse(rec.text)).toEqual({ ok: true, removed: 3 });
  });
});
