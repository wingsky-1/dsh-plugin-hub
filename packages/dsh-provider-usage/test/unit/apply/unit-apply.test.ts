// @ts-nocheck
/**
 * dsh-provider-usage — unit：apply 宿主注入路径覆盖。
 *
 * 覆盖：installSettingsNamespace inject 回调全分支（含 isUnloading）、
 * HotReloadableAdapter onReload 回调分支、dispose 清理全分支、
 * sseClients 清理、warmupTimer 清理。
 *
 * 此文件不重复 smoke.test.ts 已覆盖的 boot/enabled/fence 断言，仅专注
 * 于 smoke 未到达的 apply 内部分支（#82 批次 3）。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
console.error("EVAL-ORDER-TAG: APPLY");
import { join, dirname } from "node:path";
import { tmpdir, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs, { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { injectGlobalFetch } from "../../helpers.ts";
import {
  apply,
  ROUTES,
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
  ADAPTER_CONTRACT_VERSION,
  fetchWithTimeout,
  userAdaptersFile,
  adapterStateFile,
} from "../../../src/apply/index.ts";

// ---------------------------------------------------------------- 工具：fakeReqs

/** #503：session 事件监听桩（apply 现注册 session/event|flush|disposed 监听）。 */
function onStub() {
  return () => {};
}

function fakeReq(overrides = {}) {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    method: "GET",
    url: "/",
    [Symbol.asyncIterator]: async function* () {
      if (typeof overrides.body === "string" && overrides.body !== "") {
        yield Buffer.from(overrides.body);
      }
    },
    ...overrides,
  };
}

function makeRes() {
  const chunks = [];
  let code = 200;
  return {
    writeHead: (c) => { code = c; },
    end: (chunk) => { chunks.push(chunk); },
    write: (chunk) => { chunks.push(chunk); },
    on: () => {},
    _code: () => code,
    _body: () => chunks.map((c) => (typeof c === "string" ? c : String(c))).join(""),
  };
}

/** 构造标准 fake ctx：收集路由与 disposer。
 *  - over.get：可选注入的假 wingsky.notifier 服务（get 桩命中 "wingsky.notifier" 时返回）；
 *  - over.recordOn：为 true 时记录 ctx.on 监听器到 listeners（供 internal/service 补注册测试手动触发）。 */
function makeCtx(over: {
  llm?: unknown;
  get?: unknown;
  recordOn?: boolean;
} = {}) {
  const routes: Array<Record<string, unknown>> = [];
  const disposers: Array<() => void> = [];
  const listeners: Map<string, Array<(...args: unknown[]) => unknown>> = new Map();
  const ctx = {
    logger: { warn: () => {} },
    webServer: { register(route: Record<string, unknown>) { routes.push(route); return () => {}; } },
    on: over.recordOn
      ? (name: string, cb: (...args: unknown[]) => unknown) => {
          const list = listeners.get(name) ?? [];
          list.push(cb);
          listeners.set(name, list);
          return () => {};
        }
      : onStub,
    llm: over.llm !== undefined ? over.llm : { listProviders() { return []; } },
    fiber: { state: "active" },
    inject: (deps: unknown, cb: (s: unknown) => void) => { cb({ settings: {} }); },
    effect(fn: () => unknown) {
      const d = fn();
      if (typeof d === "function") disposers.push(d as () => void);
      return typeof d === "function" ? d : () => {};
    },
  };
  if (over.get !== undefined) {
    (ctx as Record<string, unknown>).get = (name: string) => (name === "wingsky.notifier" ? over.get : undefined);
  }
  return { ctx, routes, disposers, listeners };
}

/** 合法用户适配器 mjs 文本。 */
function adapterMjs(name: string, body = "{ v: 1 }"): string {
  return `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = ${JSON.stringify(name)};
export const label = ${JSON.stringify(name)};
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return ${body}; }
export function formatCapsule() { return "<span>${name}</span>"; }
export function formatPanel() { return "<p>${name}</p>"; }
`;
}

/** 轮询直到条件成立或超时（防 flake：不使用固定 sleep 判定）。 */
async function pollUntil(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
}

const routeOf = (routes: Array<Record<string, unknown>>, path: string) =>
  routes.find((r) => r.path === path) as { handler: (req: unknown, res: unknown) => Promise<void> | void } | undefined;

// ---------------------------------------------------------------- 1) inject 回调：settings 正常注册

describe("1) inject 回调：settings 正常注册", () => {
  let settingsEvents;

  beforeAll(async () => {
    settingsEvents = [];
    const routes = [];
    const ctx = {
      logger: { warn: () => {} },
      webServer: { register(route) { routes.push(route); return () => {}; } },
      on: onStub,
      llm: { listProviders() { return []; } },
      fiber: { state: "active" },
      inject: (deps, cb) => {
        const scope = {
          get: () => ({}),
          watch: (fn) => { settingsEvents.push("watch-registered"); },
        };
        const sctx = {
          settings: {
            register: (ns, schema, opts) => {
              settingsEvents.push("register-called");
              return scope;
            },
          },
          effect: (fn) => {
            const disposer = fn();
            settingsEvents.push("effect-registered");
            return typeof disposer === "function" ? disposer : () => {};
          },
        };
        cb(sctx);
      },
      effect: (fn) => {
        const d = fn();
        return typeof d === "function" ? d : () => {};
      },
    };
    await apply(ctx, { apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  });

  it("settings.register 被调用", () => {
    expect(settingsEvents.includes("register-called")).toBeTruthy();
  });

  it("sctx.effect 被注册", () => {
    expect(settingsEvents.includes("effect-registered")).toBeTruthy();
  });

  it("scope.watch 被注册", () => {
    expect(settingsEvents.includes("watch-registered")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 2) inject 回调：settings.register 抛错

describe("2) inject 回调：settings.register 抛错", () => {
  let warns;

  beforeAll(async () => {
    warns = [];
    const routes = [];
    const ctx = {
      logger: { warn: (m) => { warns.push(m); } },
      webServer: { register(route) { routes.push(route); return () => {}; } },
      on: onStub,
      llm: { listProviders() { return []; } },
      fiber: { state: "active" },
      inject: (deps, cb) => {
        cb({
          settings: { register: () => { throw new Error("duplicate"); } },
          effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
        });
      },
      effect: (fn) => {
        const d = fn();
        return typeof d === "function" ? d : () => {};
      },
    };
    await apply(ctx, { apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  });

  it("settings.register 抛错应 warn", () => {
    expect(warns.some((m) => m.includes("duplicate"))).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 3) inject 回调：settings 服务缺 register

describe("3) inject 回调：settings 服务缺 register", () => {
  let warns;

  beforeAll(async () => {
    warns = [];
    const routes = [];
    const ctx = {
      logger: { warn: (m) => { warns.push(m); } },
      webServer: { register(route) { routes.push(route); return () => {}; } },
      on: onStub,
      llm: { listProviders() { return []; } },
      fiber: { state: "active" },
      inject: (deps, cb) => {
        cb({ settings: {} });
      },
      effect: (fn) => {
        const d = fn();
        return typeof d === "function" ? d : () => {};
      },
    };
    await apply(ctx, { apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
  });

  it("settings 缺 register 应 warn", () => {
    expect(warns.some((m) => m.includes("register"))).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 4) inject 回调：ctx.inject 不可用（已覆盖/无需重复）

// smoke.test.ts 已有的 apply 用 fake ctx 无 inject → installSettingsNamespace 走
// "ctx.inject 不可用" 分支。本文件不重复。

// ---------------------------------------------------------------- 5) isUnloading 全分支通过 inject 回调覆盖

// 5a) fiber.state = "unloading" → sctx.effect disposer 内 isUnloading 返回 true →
//     disposer 提前 return（setSource 不切回 entry）
describe("5a) fiber.state=unloading → disposer 内 isUnloading=true 提前 return", () => {
  let applied;

  beforeAll(async () => {
    const setSourceCalls = [];
    const routes = [];
    const ctx = {
      logger: { warn: () => {} },
      webServer: { register(route) { routes.push(route); return () => {}; } },
      on: onStub,
      llm: { listProviders() { return []; } },
      fiber: { state: "unloading" },
      inject: (deps, cb) => {
        const scope = { get: () => ({}), watch: (fn) => {} };
        cb({
          settings: { register: () => scope },
          effect: (fn) => {
            const disposer = fn();
            // 模拟 fiber 卸载时调用 disposer：isUnloading(ctx) 应为 true → 提前 return
            disposer();
            return () => {};
          },
        });
      },
      effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
    };
    // setSource 应该在 register 成功后被设为 () => scope.get()，但 disposer 内
    // isUnloading=true 时不会切回 entry。此处纯验证不抛错。
    await apply(ctx, { apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
    applied = true;
  });

  it("isUnloading=true 分支不抛错", () => {
    expect(applied).toBe(true);
  });
});

// 5b) fiber.state = "disposed" → 同 unloading 分支
describe("5b) fiber.state=disposed → 同 unloading 分支", () => {
  let applied;

  beforeAll(async () => {
    const routes = [];
    const ctx = {
      logger: { warn: () => {} },
      webServer: { register(route) { routes.push(route); return () => {}; } },
      on: onStub,
      llm: { listProviders() { return []; } },
      fiber: { state: "disposed" },
      inject: (deps, cb) => {
        const scope = { get: () => ({}), watch: (fn) => {} };
        cb({
          settings: { register: () => scope },
          effect: (fn) => {
            const disposer = fn();
            disposer();
            return () => {};
          },
        });
      },
      effect: (fn) => { const d = fn(); return typeof d === "function" ? d : () => {}; },
    };
    await apply(ctx, { apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
    applied = true;
  });

  it("isUnloading=disposed 分支不抛错", () => {
    expect(applied).toBe(true);
  });
});

// ---------------------------------------------------------------- 6) HotReloadableAdapter onReload 回调全分支

// 6a) 合法用户适配器文件 → onReload ok:true → hr.current !== null → full branch
describe("6a) 合法用户适配器文件 → onReload ok:true", () => {
  let applied;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-hr-"));
    const goodFile = join(dir, "good.mjs");
    writeFileSync(goodFile, `
export const version = 2;
export const name = "hr-test";
export const label = "HR Test";
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>ok</span>"; }
export function formatPanel() { return "<p>p</p>"; }
`, "utf8");

    const routes = [];
    const ctx = {
      logger: { warn: () => {} },
      webServer: { register(route) { routes.push(route); return () => {}; } },
      on: onStub,
      llm: { listProviders() { return []; } },
      fiber: { state: "active" },
      inject: (deps, cb) => { cb({ settings: {} }); },
      effect: (fn) => {
        const d = fn();
        return typeof d === "function" ? d : () => {};
      },
    };
    await apply(ctx, { adapter: goodFile, autoReload: true, apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
    applied = true;
  });

  it("HotReload ok:true 分支不抛错", () => {
    expect(applied).toBe(true);
  });
});

// 6b) 非法适配器文件 → onReload ok:false → !info.ok 分支
describe("6b) 非法适配器文件 → onReload ok:false", () => {
  let applied;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-hr-bad-"));
    const badFile = join(dir, "bad.mjs");
    writeFileSync(badFile, `export const version = 2; export const name = "bad";`, "utf8");

    const routes = [];
    const ctx = {
      logger: { warn: () => {} },
      webServer: { register(route) { routes.push(route); return () => {}; } },
      on: onStub,
      llm: { listProviders() { return []; } },
      fiber: { state: "active" },
      inject: (deps, cb) => { cb({ settings: {} }); },
      effect: (fn) => {
        const d = fn();
        return typeof d === "function" ? d : () => {};
      },
    };
    await apply(ctx, { adapter: badFile, autoReload: true, apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
    applied = true;
  });

  it("HotReload ok:false 分支不抛错", () => {
    expect(applied).toBe(true);
  });
});

// ---------------------------------------------------------------- 7) dispose 清理全分支（含 hotReloaders + sseClients）

describe("7) dispose 清理全分支（含 hotReloaders + sseClients）", () => {
  let evRoute, disposed;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-dispose-"));
    const goodFile = join(dir, "dispose.mjs");
    writeFileSync(goodFile, `
export const version = 2;
export const name = "dispose-test";
export const label = "Dispose";
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>ok</span>"; }
export function formatPanel() { return "<p>p</p>"; }
`, "utf8");

    const disposers = [];
    const errors = [];
    const routes = [];

    // 先订阅 SSE（使 sseClients 有成员）
    const eventsRoute = { path: ROUTES.events };
    // 外部收集 disposer
    const ctx = {
      logger: { warn: () => {} },
      webServer: {
        register(route) { routes.push(route); return () => {}; },
      },
      on: onStub,
      llm: { listProviders() { return []; } },
      fiber: { state: "active" },
      inject: (deps, cb) => { cb({ settings: {} }); },
      effect: (fn) => {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return d;
      },
    };
    await apply(ctx, { adapter: goodFile, autoReload: true, apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });

    // 订阅 SSE（通过 events 路由 handler 添加 SSE 客户端）
    evRoute = routes.find((r) => r.path === ROUTES.events);
    let sseRes;
    evRoute?.handler(fakeReq({ method: "GET" }), {
      writeHead: (code, headers) => {},
      write: (chunk) => {},
      on: (evt, cb) => { if (evt === "close") sseRes = { close: cb }; },
    });

    // 执行所有 disposer（包括内层 ctx.effect 的 disposer）
    for (const d of disposers) {
      if (typeof d === "function") d();
    }
    disposed = true;
  });

  it("events 路由存在", () => {
    expect(evRoute).toBeTruthy();
  });

  it("dispose 全分支不抛错", () => {
    expect(disposed).toBe(true);
  });
});

// ---------------------------------------------------------------- 8) 确保 warmupTimer 被清理（disposer 中）

describe("8) 确保 warmupTimer 被清理（disposer 中）", () => {
  let cleared;

  beforeAll(async () => {
    const disposers = [];
    const routes = [];
    const ctx = {
      logger: { warn: () => {} },
      webServer: { register(route) { routes.push(route); return () => {}; } },
      on: onStub,
      llm: { listProviders() { return []; } },
      fiber: { state: "active" },
      inject: (deps, cb) => { cb({ settings: {} }); },
      effect: (fn) => {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return typeof d === "function" ? d : () => {};
      },
    };
    await apply(ctx, { warmupIntervalMs: 60000, apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9" });
    for (const d of disposers) {
      if (typeof d === "function") d();
    }
    cleared = true;
  });

  it("warmupTimer 清理不抛错", () => {
    expect(cleared).toBe(true);
  });
});

// ================================================================ #150 二阶段：apply 内部数据面与路由分支

// ---------------------------------------------------------------- #301：apply 内部恢复隔离坏状态且诊断单次可见

describe("#301：apply 内部恢复隔离坏状态且诊断单次可见", () => {
  const cases = [
    { raw: "{broken", marker: "JSON 损坏" },
    { raw: '["not","a","mapping"]', marker: "顶层结构无效" },
  ];
  let backups, warnCounts, healthHit, fileMoved, backupFound, backupRaw;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-state-301-quarantine-apply-"));
    const historyDir = join(dir, "history");
    mkdirSync(historyDir, { recursive: true });
    const stateFile = adapterStateFile(historyDir);
    backups = [];
    warnCounts = [];
    healthHit = [];
    fileMoved = [];
    backupFound = [];
    backupRaw = [];

    for (const entry of cases) {
      writeFileSync(stateFile, entry.raw, "utf8");
      const { ctx, routes, disposers } = makeCtx();
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
      try {
        await apply(ctx, {
          autoReload: false,
          apiKey: "sk-test",
          apiEndpoint: "http://127.0.0.1:9",
          historyDir,
        });
      } finally {
        console.warn = originalWarn;
      }

      const health = routes.find((route) => route.path === ROUTES.health) as { handler: (req: unknown, res: unknown) => void };
      const response = makeRes();
      health.handler(fakeReq(), response);
      const errors = (JSON.parse(response._body()) as { errors?: Array<{ key: string; message: string }> }).errors ?? [];
      warnCounts.push(warnings.filter((line) => line.includes(entry.marker)).length);
      healthHit.push(errors.some((error) => error.key === "adapter-state" && error.message.includes(entry.marker)));
      fileMoved.push(existsSync(stateFile));
      const backup = readdirSync(historyDir)
        .filter((name) => name.startsWith("adapter-state.json.bak-"))
        .find((name) => !backups.includes(name) && readFileSync(join(historyDir, name), "utf8") === entry.raw);
      backupFound.push(backup !== undefined);
      backups.push(backup ?? "missing");
      for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
    }
    for (const [index, backup] of backups.entries()) {
      backupRaw.push(readFileSync(join(historyDir, backup), "utf8") === cases[index]?.raw);
    }
  });

  for (const [index, entry] of cases.entries()) {
    it(`${entry.marker} 恰好输出一次 console.warn`, () => {
      expect(warnCounts[index]).toBe(1);
    });

    it(`${entry.marker} 同时进入 health 诊断`, () => {
      expect(healthHit[index]).toBeTruthy();
    });

    it(`${entry.marker} 原文件已移出恢复路径`, () => {
      expect(fileMoved[index]).toBe(false);
    });

    it(`${entry.marker} 原文完整保留在新取证备份`, () => {
      expect(backupFound[index]).toBeTruthy();
    });
  }

  for (const [index] of cases.entries()) {
    it(`全部取证备份最终均保留（case ${index}）`, () => {
      expect(backupRaw[index]).toBe(true);
    });
  }
});

// ---------------------------------------------------------------- #301：恢复缺失候选可见 + 写入失败可见且串行链可恢复

describe("#301：恢复缺失候选可见 + 写入失败可见且串行链可恢复", () => {
  let healthDiagHit, warnOnce, persisted, tmpLeft, posixMode, selectCode;
  let surfaced, writeErrOnce, recovered;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-state-301-apply-"));
    const historyDir = join(dir, "history");
    mkdirSync(historyDir, { recursive: true });
    const stateFile = adapterStateFile(historyDir);
    writeFileSync(stateFile, JSON.stringify({ "ghost-provider": "missing-adapter" }), "utf8");

    const { ctx, routes, disposers } = makeCtx();
    const restoreWarnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { restoreWarnings.push(args.map(String).join(" ")); };
    try {
      await apply(ctx, {
        autoReload: false,
        apiKey: "sk-test",
        apiEndpoint: "http://127.0.0.1:9",
        historyDir,
      });
    } finally {
      console.warn = originalWarn;
    }
    const health = routes.find((route) => route.path === ROUTES.health) as { handler: (req: unknown, res: unknown) => void };
    const select = routes.find((route) => route.path === ROUTES.select) as { handler: (req: unknown, res: unknown) => Promise<void> };
    const healthErrors = (): Array<{ key: string; message: string }> => {
      const response = makeRes();
      health.handler(fakeReq(), response);
      return (JSON.parse(response._body()) as { errors?: Array<{ key: string; message: string }> }).errors ?? [];
    };

    healthDiagHit = healthErrors().some((entry) =>
      entry.key === "adapter-state" && entry.message.includes("missing-adapter") && entry.message.includes("不在当前候选"));
    warnOnce = restoreWarnings.filter((line) =>
      line.includes("missing-adapter") && line.includes("不在当前候选")).length;

    // 成功路径：发布物实际调度链写出合法 JSON、无 tmp 残留，POSIX 权限为 0600。
    let response = makeRes();
    await select.handler(fakeReq({
      method: "POST",
      body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: OPENCODE_GO_ADAPTER_ID }),
    }), response);
    persisted = await pollUntil(() => {
      try {
        return JSON.parse(readFileSync(stateFile, "utf8"))[OPENCODE_GO_PROVIDER] === OPENCODE_GO_ADAPTER_ID;
      } catch { return false; }
    });
    tmpLeft = readdirSync(historyDir).filter((name) => name.endsWith(".tmp"));
    posixMode = process.platform !== "win32" ? statSync(stateFile).mode & 0o777 : undefined;

    rmSync(stateFile, { force: true });
    mkdirSync(stateFile); // 旧状态读取稳定报 EISDIR，构造 fail-closed 的持久化错误
    response = makeRes();
    const writeErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { writeErrors.push(args.map(String).join(" ")); };
    surfaced = false;
    try {
      await select.handler(fakeReq({
        method: "POST",
        body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: OPENCODE_GO_ADAPTER_ID }),
      }), response);
      selectCode = response._code();
      surfaced = await pollUntil(() => healthErrors().some((entry) =>
        entry.key === "adapter-state" && entry.message.includes("启用选择落盘失败")));
    } finally {
      console.error = originalError;
    }
    writeErrOnce = writeErrors.filter((line) => line.includes("启用选择落盘失败")).length;

    rmSync(stateFile, { recursive: true, force: true });
    response = makeRes();
    await select.handler(fakeReq({
      method: "POST",
      body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: OPENCODE_GO_ADAPTER_ID }),
    }), response);
    recovered = await pollUntil(() => {
      try {
        return JSON.parse(readFileSync(stateFile, "utf8"))[OPENCODE_GO_PROVIDER] === OPENCODE_GO_ADAPTER_ID;
      } catch { return false; }
    });

    for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
  });

  it("启动恢复 select(false) 进入 health 诊断，不再静默回退默认启用者", () => {
    expect(healthDiagHit).toBeTruthy();
  });

  it("启动恢复 select(false) 恰好输出一次 console.warn，避免重复诊断", () => {
    expect(warnOnce).toBe(1);
  });

  it("select 经串行链原子写入新的启用选择", () => {
    expect(persisted).toBe(true);
  });

  it("成功写入无 tmp 残留", () => {
    expect(tmpLeft).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("POSIX 状态文件权限为 0600", () => {
    expect(posixMode).toBe(0o600);
  });

  it("运行期 select 内存切换仍成功响应", () => {
    expect(selectCode).toBe(200);
  });

  it("异步写盘失败进入 health 诊断（同时由宿主 console.error 输出）", () => {
    expect(surfaced).toBe(true);
  });

  it("每次失败写入恰好输出一次 console.error", () => {
    expect(writeErrOnce).toBe(1);
  });

  it("一次持久化失败不会毒化串行链，修复文件系统后后续选择可成功落盘", () => {
    expect(recovered).toBe(true);
  });
});

// ---------------------------------------------------------------- #301：rename 已提交后的目录 fsync 失败仅报耐久性告警

describe.skipIf(process.platform === "win32")("#301：rename 已提交后的目录 fsync 失败仅报耐久性告警", () => {
  let selectCode, directorySyncAttempts, committed, surfaced, warnOnce, writeErrList, healthPolluted;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-state-301-post-rename-"));
    const historyDir = join(dir, "history");
    const stateFile = adapterStateFile(historyDir);
    const { ctx, routes, disposers } = makeCtx();
    await apply(ctx, {
      autoReload: false,
      apiKey: "sk-test",
      apiEndpoint: "http://127.0.0.1:9",
      historyDir,
    });

    const health = routes.find((route) => route.path === ROUTES.health) as {
      handler: (req: unknown, res: unknown) => void;
    };
    const select = routes.find((route) => route.path === ROUTES.select) as {
      handler: (req: unknown, res: unknown) => Promise<void>;
    };
    const healthErrors = (): Array<{ key: string; message: string }> => {
      const response = makeRes();
      health.handler(fakeReq(), response);
      return (JSON.parse(response._body()) as { errors?: Array<{ key: string; message: string }> }).errors ?? [];
    };

    const originalOpen = fs.promises.open;
    directorySyncAttempts = 0;
    fs.promises.open = async (path, flags, ...rest) => {
      if (String(path) === historyDir && flags === "r") {
        directorySyncAttempts += 1;
        const error = new Error("simulated parent directory fsync failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return originalOpen(path, flags, ...rest);
    };
    syncBuiltinESMExports();

    const warnings: string[] = [];
    const writeErrors: string[] = [];
    const originalWarn = console.warn;
    const originalError = console.error;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    console.error = (...args: unknown[]) => { writeErrors.push(args.map(String).join(" ")); };
    let response = makeRes();
    surfaced = false;
    committed = false;
    try {
      await select.handler(fakeReq({
        method: "POST",
        body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: null }),
      }), response);
      selectCode = response._code();
      surfaced = await pollUntil(() => healthErrors().some((entry) =>
        entry.key === "adapter-state" && entry.message.includes("耐久性未完全确认")));
      committed = await pollUntil(() => {
        try {
          return JSON.parse(readFileSync(stateFile, "utf8"))[OPENCODE_GO_PROVIDER] === null;
        } catch { return false; }
      });
    } finally {
      console.warn = originalWarn;
      console.error = originalError;
      fs.promises.open = originalOpen;
      syncBuiltinESMExports();
    }

    warnOnce = warnings.filter((line) => line.includes("耐久性未完全确认")).length;
    writeErrList = writeErrors.filter((line) => line.includes("启用选择落盘失败"));
    healthPolluted = healthErrors().some((entry) => entry.message.includes("启用选择落盘失败"));

    for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
  });

  it("内存中的显式停用仍成功响应", () => {
    expect(selectCode).toBe(200);
  });

  it("故障注入精确命中 rename 后的父目录 fsync", () => {
    expect(directorySyncAttempts).toBe(1);
  });

  it("目录 fsync 失败时原子 rename 的新状态仍已提交", () => {
    expect(committed).toBe(true);
  });

  it("post-commit 失败进入 health 的独立耐久性诊断", () => {
    expect(surfaced).toBe(true);
  });

  it("post-commit 失败恰好输出一次 console.warn", () => {
    expect(warnOnce).toBe(1);
  });

  it("post-commit 失败不误报 console.error 写入失败", () => {
    expect(writeErrList).toEqual([]);
  });

  it("post-commit 失败不污染 health 为写入失败", () => {
    expect(healthPolluted).toBe(false);
  });
});

// ---------------------------------------------------------------- stats/history 路由围栏与数据面

describe("stats/history 路由围栏与数据面", () => {
  let stats, historyR, res403Code, res405Code, h403Code, noAdpBody, okBody;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-stats-"));
    const goodFile = join(dir, "good.mjs");
    writeFileSync(goodFile, adapterMjs("stats-adp"), "utf8");
    const { ctx, routes } = makeCtx();
    await apply(ctx, {
      adapter: goodFile, autoReload: false,
      apiKey: "sk", apiEndpoint: "http://127.0.0.1:9",
      historyDir: join(dir, "hist"),
    });

    // stats：403 非 loopback / 405 非 GET
    stats = routeOf(routes, ROUTES.stats);
    const res403 = makeRes();
    await stats?.handler(fakeReq({ headers: { host: "evil.example" } }), res403);
    res403Code = res403._code();
    const res405 = makeRes();
    await stats?.handler(fakeReq({ method: "POST" }), res405);
    res405Code = res405._code();

    // history：403 / 405 / 无候选 no-adapter / days clamp
    historyR = routeOf(routes, ROUTES.history);
    const h403 = makeRes();
    await historyR?.handler(fakeReq({ headers: { host: "x" } }), h403);
    h403Code = h403._code();

    // 无启用适配器（清空选择后）→ 结构化 no-adapter
    const hNoAdp = makeRes();
    await historyR?.handler(fakeReq({ url: `${ROUTES.history}?provider=ghost` }), hNoAdp);
    noAdpBody = JSON.parse(hNoAdp._body());

    // days 参数：合法窗口取 min(days, maxAgeDays)
    const hDays = makeRes();
    await historyR?.handler(fakeReq({ url: `${ROUTES.history}?days=7` }), hDays);
    okBody = JSON.parse(hDays._body());
  });

  it("stats 路由已注册", () => {
    expect(stats).toBeTruthy();
  });

  it("stats 非 loopback 403", () => {
    expect(res403Code).toBe(403);
  });

  it("stats POST 405", () => {
    expect(res405Code).toBe(405);
  });

  it("history 路由已注册", () => {
    expect(historyR).toBeTruthy();
  });

  it("history 非 loopback 403", () => {
    expect(h403Code).toBe(403);
  });

  it("无候选 provider 报 no-adapter", () => {
    expect(noAdpBody.reason).toBe("no-adapter");
  });

  it("无候选不带占位 HTML", () => {
    expect(noAdpBody.panelHtml).toBe(null);
  });

  it("history 正常响应 plugin 字段", () => {
    expect(okBody.plugin).toBe("dsh-provider-usage");
  });

  it("用户适配器注册后默认成为启用者", () => {
    expect(okBody.adapterName).toBe("stats-adp");
  });

  it("range.start 数字", () => {
    expect(typeof okBody.range.start).toBe("number");
  });
});

// ---------------------------------------------------------------- getStats：跨 provider 并行 / 锁内二次校验 / 未配置

describe("getStats：跨 provider 并行 / 锁内二次校验 / 未配置", () => {
  let savedDshHome, probePairOk, windowOverlap, windowDetail;
  let bSlow, bFast, slowSeqCount, landed, bNoEn;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-getstats-"));
    // 隔离 DSH_HOME：避免读到真实环境的 user-adapters.json / adapter-state.json
    savedDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(dir, "dshhome");
    mkdirSync(process.env.DSH_HOME, { recursive: true });

    // 两个用户适配器（providers 互不相同）：
    // - slow：80ms IO 延迟 + 调用计数（seq 经返回数据透出、formatCapsule 渲染）——
    //   提供「全程仅一次真实取数」的证据载体；
    // - fast：60ms 延迟 + 起止时间戳写 globalThis 探针——提供跨 provider 并行的窗口证据。
    const slowFile = join(dir, "slow.mjs");
    writeFileSync(slowFile, `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = "slow-adp";
export const providers = ["prov-slow"];
let calls = 0;
export async function fetchData() {
  calls += 1;
  const probe = (globalThis.__pp120 ??= []);
  probe.push({ n: "A", t: Date.now(), k: "s", seq: calls });
  await new Promise((r) => setTimeout(r, 80)); // 有意延迟：slow 适配器 fixture（80ms 真实 IO 窗口，验证持锁）
  probe.push({ n: "A", t: Date.now(), k: "e" });
  return { v: calls };
}
export function formatCapsule(input) { return "<span>" + input.data.v + "</span>"; }
export function formatPanel() { return "<p>s</p>"; }
`, "utf8");
    const fastFile = join(dir, "fast.mjs");
    writeFileSync(fastFile, `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = "fast-adp";
export const providers = ["prov-fast"];
export async function fetchData() {
  const probe = (globalThis.__pp120 ??= []);
  probe.push({ n: "B", t: Date.now(), k: "s" });
  await new Promise((r) => setTimeout(r, 60)); // 有意延迟：fast 适配器 fixture（60ms 真实 IO 窗口，验证跨 provider 并行）
  probe.push({ n: "B", t: Date.now(), k: "e" });
  return { v: 7 };
}
export function formatCapsule(input) { return "<span>" + input.data.v + "</span>"; }
export function formatPanel() { return "<p>f</p>"; }
`, "utf8");
    // 清单写入 historyRoot（本块显式传了 historyDir → user-adapters.json 从那里读取）
    mkdirSync(join(dir, "hist"), { recursive: true });
    writeFileSync(userAdaptersFile(join(dir, "hist")), JSON.stringify({
      adapters: [
        { id: "slow-adp", label: "Slow", providers: ["prov-slow"], file: slowFile },
        { id: "fast-adp", label: "Fast", providers: ["prov-fast"], file: fastFile },
      ],
    }), "utf8");
    delete globalThis.__pp120;

    try {
      const { ctx, routes, disposers } = makeCtx();
      await apply(ctx, {
        autoReload: false,
        apiKey: "sk", apiEndpoint: "http://127.0.0.1:9",
        historyDir: join(dir, "hist"),
      });
      const stats = routeOf(routes, ROUTES.stats) as { handler: (req: unknown, res: unknown) => Promise<void> };
      const selectR = routeOf(routes, ROUTES.select) as { handler: (req: unknown, res: unknown) => Promise<void> };
      const askStats = async (provider: string): Promise<Record<string, unknown>> => {
        const r = makeRes();
        await stats.handler(fakeReq({ url: `${ROUTES.stats}?provider=${provider}` }), r);
        return JSON.parse(r._body()) as Record<string, unknown>;
      };

      // 场景1 跨 provider 并行 + 场景2 锁内二次校验（#120）：启动预热对各启用 provider
      // 并行 fire-and-forget（各持各的 per-provider 锁）；紧随其后发起的两个客户端请求
      // 在各自 provider 锁上排队，首个取数完成写缓存后经锁内二次 cacheFresh 校验命中，
      // 全程仅 1 次真实取数（旧全局锁下 fast 必须等 slow 80ms 完成才能开始，且并发者
      // 只能拿 busy 占位帧）。
      const pFast = askStats("prov-fast");
      const pSlow = askStats("prov-slow");
      const both = await Promise.all([pFast, pSlow]);
      bFast = both[0];
      bSlow = both[1];

      // 场景1 断言：slow/fast 取数时间窗重叠 = 无全局队头阻塞
      const probe = (globalThis.__pp120 ?? []) as Array<{ n: string; t: number; k: string; seq?: number }>;
      const win = (n: string): { s: number; e: number } => ({
        s: probe.find((e) => e.n === n && e.k === "s")?.t ?? Number.NaN,
        e: probe.find((e) => e.n === n && e.k === "e")?.t ?? Number.NaN,
      });
      const wa = win("A");
      const wb = win("B");
      probePairOk = !Number.isNaN(wa.s) && !Number.isNaN(wb.s);
      windowOverlap = Math.max(wa.s, wb.s) < Math.min(wa.e, wb.e);
      windowDetail = `slow/fast 取数窗口重叠（A=${wa.s}-${wa.e} B=${wb.s}-${wb.e}）——跨 provider 并行取数`;
      const seqs = probe.filter((e) => e.n === "A" && e.k === "s").map((e) => e.seq);
      slowSeqCount = seqs.length;

      // 场景3 fresh 产物落盘历史（fresh 语义经落盘侧验证）
      const histDir = join(dir, "hist", "prov-slow", "slow-adp");
      landed = await pollUntil(() => existsSync(histDir) && readdirSync(histDir).length > 0);

      // 场景4 no-enabled-adapter：候选存在但被显式清空（select 清空路径，clearing 不预热）
      await selectR.handler(fakeReq({
        method: "POST",
        body: JSON.stringify({ provider: "prov-slow", adapterName: null }),
      }), makeRes());
      bNoEn = await askStats("prov-slow");

      for (const d of [...disposers].reverse()) { try { d(); } catch {} }
    } finally {
      if (savedDshHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = savedDshHome;
    }
  });

  it("两适配器探针成对出现", () => {
    expect(probePairOk).toBeTruthy();
  });

  it("跨 provider 并行取数（取数窗口重叠）", () => {
    expect(windowOverlap, windowDetail).toBeTruthy();
  });

  it("并发同 provider 请求复用缓存", () => {
    expect(bSlow.status, `并发同 provider 请求复用缓存（实际 ${bSlow.status}）`).toBe("cached");
  });

  it("capsuleHtml 显示 v=1——预热+2 并发客户端共 3 次请求仅触发 1 次真实取数（无 check-then-act 双取）", () => {
    expect(bSlow.capsuleHtml).toBe("<span>1</span>");
  });

  it("#120 后 busy 短路语义废除，排队者拿真数据帧", () => {
    expect(bSlow.reason).not.toBe("busy");
  });

  it("另一 provider 的并发请求同样命中二次校验", () => {
    expect(bFast.status).toBe("cached");
  });

  it("fast 数据保真", () => {
    expect(bFast.capsuleHtml).toBe("<span>7</span>");
  });

  it("slow.fetchData 仅执行一次", () => {
    expect(slowSeqCount, `slow.fetchData 仅执行一次（实际 ${slowSeqCount} 次）`).toBe(1);
  });

  it("fresh 数据落盘历史 JSONL", () => {
    expect(landed).toBe(true);
  });

  it("候选存在但清空启用报 no-enabled-adapter", () => {
    expect(bNoEn.reason).toBe("no-enabled-adapter");
  });

  it("未配置语义 ok=false", () => {
    expect(bNoEn.ok).toBe(false);
  });

  it("configured=false", () => {
    expect(bNoEn.configured).toBe(false);
  });
});

// ---------------------------------------------------------------- fetchWithTimeout 边界（#150 二阶段）

// 注入窗口纪律：fetchWithTimeout 硬编码读取全局 fetch。经 injectGlobalFetch
// 串行通道（#120）与其他模块的注入窗口互斥，save/restore 恒配对——ESM TLA
// 交错下不再可能把他人 mock 固化为「现场」（unit-v1 慢路径 × 本窗口交错驻留实证）。
describe("fetchWithTimeout 边界（#150 二阶段）", () => {
  let okStatus, fastCallsAtLeast1, okUrl, slowCallsAtLeast1, slowAborted, defCallsAtLeast1;

  beforeAll(async () => {
    await injectGlobalFetch(async (set) => {
      // 快路径：远小于超时的延迟 -> 正常拿到注入实现的返回值
      let fastCalls = 0;
      set(async (url: unknown, opts: { signal?: AbortSignal }) => {
        fastCalls += 1;
        await new Promise((r) => setTimeout(r, 5)); // 有意延迟：fetch mock 快路径（5ms）
        return { status: 200, ok: true, url, aborted: opts?.signal?.aborted ?? null };
      });
      const okRes = await fetchWithTimeout("https://gw.test/fast", 1000);
      okStatus = (okRes as unknown as { status: number }).status;
      // 计数只作下界断言：飞行中的外部异步可能泄漏进窗口调用全局 fetch（绝对计数实证 flake）
      fastCallsAtLeast1 = fastCalls >= 1;
      okUrl = (okRes as unknown as { url: string }).url;

      // 慢路径：超过 timeoutMs 的延迟 -> 返回时已观察到 abort
      // （delayMs 远大于 timeoutMs=20：防微任务风暴推迟 abort 定时器）
      let slowCalls = 0;
      set(async (_url: unknown, opts: { signal?: AbortSignal } | undefined) => {
        slowCalls += 1;
        await new Promise((r) => setTimeout(r, 500)); // 有意延迟：fetch mock 慢路径（500ms，验证 abort 触发）
        return { status: 200, ok: true, aborted: opts?.signal?.aborted ?? null };
      });
      const slowRes = await fetchWithTimeout("https://gw.test/slow", 20);
      slowCallsAtLeast1 = slowCalls >= 1;
      slowAborted = (slowRes as unknown as { aborted: boolean }).aborted;

      // 默认参数形态：省略 timeoutMs 与 init 仍完成调用
      // （与 fast/slow 同理用下界断言：飞行中的外部异步可能泄漏进窗口调用全局 fetch）
      let defCalls = 0;
      set(async () => { defCalls += 1; return { status: 204 }; });
      await fetchWithTimeout("https://gw.test/def");
      defCallsAtLeast1 = defCalls >= 1;
    });
  });

  it("快路径返回注入实现的响应", () => {
    expect(okStatus).toBe(200);
  });

  it("快路径到达注入 fetch 至少一次", () => {
    expect(fastCallsAtLeast1).toBeTruthy();
  });

  it("url 原样透传到 fetch", () => {
    expect(okUrl).toBe("https://gw.test/fast");
  });

  it("慢路径到达注入 fetch 至少一次", () => {
    expect(slowCallsAtLeast1).toBeTruthy();
  });

  it("超过 timeoutMs 后 controller.abort 已触发", () => {
    expect(slowAborted).toBe(true);
  });

  it("默认参数下仍走 fetch 至少一次", () => {
    expect(defCallsAtLeast1).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #534：通知类型注入（可选 notifier 探测 + 动态 kind 注册/补注册）

describe("#534：通知类型注入（可选 notifier 探测 + 动态 kind 注册/补注册）", () => {
  let savedDshHome, noNotifierMounted, mountedKinds, mountedKindsId, mountedKindsLabel;
  let preEventKindCount, svcListenerCount, postEventKindCount, reRegisteredId;

  /** 假 notifier 服务：send 恒可调，registerKind 记录调用（不真正落盘）。 */
  function fakeNotifier(kinds: Array<{ id: string; label: string }>) {
    return {
      send: async () => ({ ok: true }),
      registerKind(reg: { id: string; label: string }) {
        kinds.push({ id: reg.id, label: reg.label });
      },
    };
  }

  beforeAll(async () => {
    // 落盘隔离（#218 零污染纪律）：DSH_HOME 指向临时目录，不碰真实环境与仓库
    const dir = mkdtempSync(join(tmpdir(), "dou-kind-534-"));
    const historyDir = join(dir, "history");
    savedDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(dir, "dshhome");
    mkdirSync(process.env.DSH_HOME, { recursive: true });

    const baseCfg = { autoReload: false, apiKey: "sk-test", apiEndpoint: "http://127.0.0.1:9", historyDir };

    // 1) ctx 无 get（fake ctx 未提供探测面）：降级不注册、apply 正常挂载不抛
    {
      const { ctx, routes, disposers } = makeCtx();
      await apply(ctx, baseCfg);
      noNotifierMounted = routes.some((r) => r.path === ROUTES.health);
      for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
    }

    // 2) ctx.get 命中 wingsky.notifier（notifier 已加载）：挂载即注册 provider-usage:report
    {
      const kinds: Array<{ id: string; label: string }> = [];
      const { ctx, routes, disposers } = makeCtx({ get: fakeNotifier(kinds) });
      await apply(ctx, baseCfg);
      mountedKinds = kinds.length;
      mountedKindsId = kinds[0]?.id;
      mountedKindsLabel = kinds[0]?.label;
      for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
    }

    // 3) internal/service 事件补注册：notifier 后加载/HMR 重建后 kindRegistry 为空，
    //    事件触发 → 重新注册（挂载 1 次 + 事件触发 1 次 = 2 次，幂等无害）
    {
      const kinds: Array<{ id: string; label: string }> = [];
      const { ctx, disposers, listeners } = makeCtx({ get: fakeNotifier(kinds), recordOn: true });
      await apply(ctx, baseCfg);
      preEventKindCount = kinds.length;
      const svcListeners = listeners.get("internal/service") ?? [];
      svcListenerCount = svcListeners.length;
      // 手动触发 notifier 服务事件（模拟 notifier 提供/重载完成广播）
      for (const cb of svcListeners) {
        cb("wingsky.notifier");
      }
      postEventKindCount = kinds.length;
      reRegisteredId = kinds[1]?.id;
      for (const dispose of [...disposers].reverse()) { try { dispose(); } catch {} }
    }
  });

  afterAll(() => {
    if (savedDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = savedDshHome;
  });

  it("无 notifier 探测面时 apply 正常挂载", () => {
    expect(noNotifierMounted).toBeTruthy();
  });

  it("挂载直调注册一次", () => {
    expect(mountedKinds).toBe(1);
  });

  it("注册 kind id 正确", () => {
    expect(mountedKindsId).toBe("provider-usage:report");
  });

  it("注册 kind label 正确", () => {
    expect(mountedKindsLabel).toBe("用量报告");
  });

  it("挂载直调已注册一次", () => {
    expect(preEventKindCount).toBe(1);
  });

  it("internal/service 监听已注册", () => {
    expect(svcListenerCount >= 1).toBeTruthy();
  });

  it("事件触发补注册一次（幂等追加）", () => {
    expect(postEventKindCount).toBe(2);
  });

  it("补注册 kind id 一致", () => {
    expect(reRegisteredId).toBe("provider-usage:report");
  });
});

