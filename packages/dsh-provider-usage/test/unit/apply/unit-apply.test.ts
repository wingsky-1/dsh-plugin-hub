/**
 * dsh-provider-usage — unit：apply 宿主注入路径覆盖。
 *
 * 覆盖：installSettingsNamespace inject 回调分支、
 * HotReloadableAdapter onReload 回调分支、warmup/prune 定时器清理（假时钟句柄计数）。
 *
 * P1 恒真（`flag=true` 无条件置位）用例已删：5a/5b isUnloading、7) dispose、
 * 8) warmup 旧版；清理事实由 8) 句柄计数真断言与 schedule D3 toFake 面钉住。
 *
 * 此文件不重复 smoke.test.ts 已覆盖的 boot/enabled/fence 断言，仅专注
 * 于 smoke 未到达的 apply 内部分支（#82 批次 3）。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
console.error("EVAL-ORDER-TAG: APPLY");
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs, { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { injectGlobalFetch, pollUntil } from "../../helpers.ts";
import { apply, ROUTES } from "../../../src/apply/index.ts";
// 白盒直连深路径（#768 B波）：OpenCode 双值经适配器域门面，不走组合根转发。
import {
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
} from "../../../src/server/adapters/interface.ts";
// 白盒直连深路径（#768 B波）：契约版本经 shared 门面，不走组合根转发。
import { ADAPTER_CONTRACT_VERSION } from "../../../src/shared/interface.ts";
// 白盒直连深路径（#768 B波）：用户适配器路径纯面经注册表域门面，不走组合根转发。
import { userAdaptersFile, adapterStateFile } from "../../../src/server/registry/interface.ts";
import { fetchWithTimeout } from "../../../src/server/pipeline/interface.ts";

// ---------------------------------------------------------------- 工具：fakeReqs

/** #503：session 事件监听桩（apply 现注册 session/event|flush|disposed 监听）。 */
function onStub() {
  return () => {};
}

function fakeReq(overrides: { body?: string } & Record<string, unknown> = {}) {
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

function makeRes(): {
  writeHead: (c: number) => void;
  end: (chunk: unknown) => void;
  write: (chunk: unknown) => void;
  on: () => void;
  _code: () => number;
  _body: () => string;
} {
  const chunks: Array<unknown> = [];
  let code = 200;
  return {
    writeHead: (c: number) => {
      code = c;
    },
    end: (chunk: unknown) => {
      chunks.push(chunk);
    },
    write: (chunk: unknown) => {
      chunks.push(chunk);
    },
    on: () => {},
    _code: () => code,
    _body: () => chunks.map((c) => (typeof c === "string" ? c : String(c))).join(""),
  };
}

/** 构造标准 fake ctx：收集路由与 disposer。
 *  - over.get：可选注入的假 wingsky.notifier 服务（get 桩命中 "wingsky.notifier" 时返回）；
 *  - over.recordOn：为 true 时记录 ctx.on 监听器到 listeners（供 internal/service 补注册测试手动触发）。 */
function makeCtx(
  over: {
    llm?: unknown;
    get?: unknown;
    recordOn?: boolean;
  } = {},
) {
  const routes: Array<Record<string, unknown>> = [];
  const disposers: Array<() => void> = [];
  const listeners: Map<string, Array<(...args: unknown[]) => unknown>> = new Map();
  const ctx = {
    logger: { warn: () => {} },
    webServer: {
      register(route: Record<string, unknown>) {
        routes.push(route);
        return () => {};
      },
    },
    on: over.recordOn
      ? (name: string, cb: (...args: unknown[]) => unknown) => {
          const list = listeners.get(name) ?? [];
          list.push(cb);
          listeners.set(name, list);
          return () => {};
        }
      : onStub,
    llm:
      over.llm !== undefined
        ? over.llm
        : {
            listProviders() {
              return [];
            },
          },
    fiber: { state: "active" },
    inject: (deps: unknown, cb: (s: unknown) => void) => {
      cb({ settings: {} });
    },
    effect(fn: () => unknown) {
      const d = fn();
      if (typeof d === "function") disposers.push(d as () => void);
      return typeof d === "function" ? d : () => {};
    },
  };
  if (over.get !== undefined) {
    (ctx as Record<string, unknown>).get = (name: string) =>
      name === "wingsky.notifier" ? over.get : undefined;
  }
  // apply 的 ctx 为宿主 cordis 全量服务面，窄 fake 经 unknown 断言装配（调用点同构）。
  return { ctx: ctx as unknown as Parameters<typeof apply>[0], routes, disposers, listeners };
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

// W5：删本地 pollUntil，统一引用 test/helpers.ts 共享版。逐行比对（本地原 142-150 vs 共享 100-112），语义不同处以共享版为准：
// - 本地 cond 仅同步 boolean，共享 cond 可 async 且泛型返回真值（以共享为准，本文件调用仍为同步 boolean 面，true/false 语义一致）；
// - 本地默认 2000ms/10ms，共享默认 5000ms/50ms（以共享为准，本文件 6 处调用均无显式参数，统一放宽到共享口径）；
// - 本地 deadline 前 while+末次 cond()，共享 deadline 后返回末次 v（以共享为准，保证至少一次求值，超时返回末次假值）。

const routeOf = (routes: Array<Record<string, unknown>>, path: string) =>
  routes.find((r) => r.path === path) as
    { handler: (req: unknown, res: unknown) => Promise<void> | void } | undefined;

// ---------------------------------------------------------------- 1) inject 回调：settings 正常注册

describe("1) inject 回调：settings 正常注册", () => {
  let settingsEvents: string[];

  beforeAll(async () => {
    settingsEvents = [];
    const routes: Array<Record<string, unknown>> = [];
    const ctx = {
      logger: { warn: () => {} },
      webServer: {
        register(route: Record<string, unknown>) {
          routes.push(route);
          return () => {};
        },
      },
      on: onStub,
      llm: {
        listProviders() {
          return [];
        },
      },
      fiber: { state: "active" },
      inject: (deps: unknown, cb: (s: unknown) => void) => {
        const scope = {
          get: () => ({}),
          watch: (_fn: () => void) => {
            settingsEvents.push("watch-registered");
          },
        };
        const sctx = {
          settings: {
            register: (_ns: unknown, _schema: unknown, _opts: unknown) => {
              settingsEvents.push("register-called");
              return scope;
            },
          },
          effect: (fn: () => unknown) => {
            const disposer = fn();
            settingsEvents.push("effect-registered");
            return typeof disposer === "function" ? disposer : () => {};
          },
        };
        cb(sctx);
      },
      effect: (fn: () => unknown) => {
        const d = fn();
        return typeof d === "function" ? d : () => {};
      },
    };
    // 隔离（#768 P1）：historyDir 指临时目录，否则 apply.ts:275 回落真实 ~/.dsh
    // （installUpgrade 写 .upgrade-version、TrendTracker 建 trend 目录）。
    const dir = mkdtempSync(join(tmpdir(), "dou-apply-inject-ok-"));
    await apply(ctx as unknown as Parameters<typeof apply>[0], {
      apiKey: "sk-test",
      apiEndpoint: "http://127.0.0.1:9",
      historyDir: join(dir, "hist"),
    });
  });

  it("settings.register 被调用", () => {
    // 实现真值（shared/settings-namespace.js installSettingsNamespace）：
    // register → sctx.effect → scope.watch 按序各推一事件，一次 inject 回调恰好三项。
    expect(settingsEvents).toEqual(["register-called", "effect-registered", "watch-registered"]);
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
  let warns: string[];

  beforeAll(async () => {
    warns = [];
    const routes: Array<Record<string, unknown>> = [];
    const ctx = {
      logger: {
        warn: (m: string) => {
          warns.push(m);
        },
      },
      webServer: {
        register(route: Record<string, unknown>) {
          routes.push(route);
          return () => {};
        },
      },
      on: onStub,
      llm: {
        listProviders() {
          return [];
        },
      },
      fiber: { state: "active" },
      inject: (deps: unknown, cb: (s: unknown) => void) => {
        cb({
          settings: {
            register: () => {
              throw new Error("duplicate");
            },
          },
          effect: (fn: () => unknown) => {
            const d = fn();
            return typeof d === "function" ? d : () => {};
          },
        });
      },
      effect: (fn: () => unknown) => {
        const d = fn();
        return typeof d === "function" ? d : () => {};
      },
    };
    // 隔离（#768 P1）：同 1)，无 historyDir 则回落真实 ~/.dsh 写版本与 trend 目录。
    const dir = mkdtempSync(join(tmpdir(), "dou-apply-inject-throw-"));
    await apply(ctx as unknown as Parameters<typeof apply>[0], {
      apiKey: "sk-test",
      apiEndpoint: "http://127.0.0.1:9",
      historyDir: join(dir, "hist"),
    });
  });

  it("settings.register 抛错应 warn", () => {
    expect(warns.some((m) => m.includes("duplicate"))).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 3) inject 回调：settings 服务缺 register

describe("3) inject 回调：settings 服务缺 register", () => {
  let warns: string[];

  beforeAll(async () => {
    warns = [];
    const routes: Array<Record<string, unknown>> = [];
    const ctx = {
      logger: {
        warn: (m: string) => {
          warns.push(m);
        },
      },
      webServer: {
        register(route: Record<string, unknown>) {
          routes.push(route);
          return () => {};
        },
      },
      on: onStub,
      llm: {
        listProviders() {
          return [];
        },
      },
      fiber: { state: "active" },
      inject: (deps: unknown, cb: (s: unknown) => void) => {
        cb({ settings: {} });
      },
      effect: (fn: () => unknown) => {
        const d = fn();
        return typeof d === "function" ? d : () => {};
      },
    };
    // 隔离（#768 P1）：同 1)，无 historyDir 则回落真实 ~/.dsh 写版本与 trend 目录。
    const dir = mkdtempSync(join(tmpdir(), "dou-apply-inject-noreg-"));
    await apply(ctx as unknown as Parameters<typeof apply>[0], {
      apiKey: "sk-test",
      apiEndpoint: "http://127.0.0.1:9",
      historyDir: join(dir, "hist"),
    });
  });

  it("settings 缺 register 应 warn", () => {
    expect(warns.some((m) => m.includes("register"))).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 4) inject 回调：ctx.inject 不可用（已覆盖/无需重复）

// smoke.test.ts 已有的 apply 用 fake ctx 无 inject → installSettingsNamespace 走
// "ctx.inject 不可用" 分支。本文件不重复。

// ---------------------------------------------------------------- 6) HotReloadableAdapter onReload 回调全分支

// 6a) 合法用户适配器文件 → onReload ok:true → hr.current !== null → full branch
describe("6a) 合法用户适配器文件 → onReload ok:true", () => {
  let applied: boolean;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "dou-hr-"));
    const goodFile = join(dir, "good.mjs");
    writeFileSync(
      goodFile,
      `
export const version = ${ADAPTER_CONTRACT_VERSION};
export const name = "hr-test";
export const label = "HR Test";
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>ok</span>"; }
export function formatPanel() { return "<p>p</p>"; }
`,
      "utf8",
    );

    const routes: Array<Record<string, unknown>> = [];
    const ctx = {
      logger: { warn: () => {} },
      webServer: {
        register(route: Record<string, unknown>) {
          routes.push(route);
          return () => {};
        },
      },
      on: onStub,
      llm: {
        listProviders() {
          return [];
        },
      },
      fiber: { state: "active" },
      inject: (deps: unknown, cb: (s: unknown) => void) => {
        cb({ settings: {} });
      },
      effect: (fn: () => unknown) => {
        const d = fn();
        return typeof d === "function" ? d : () => {};
      },
    };
    await apply(ctx as unknown as Parameters<typeof apply>[0], {
      adapter: goodFile,
      autoReload: true,
      apiKey: "sk-test",
      apiEndpoint: "http://127.0.0.1:9",
      // 隔离（#768 P1）：复用本块 mkdtemp 目录；不传则回落真实 ~/.dsh 写版本与 trend 目录。
      historyDir: join(dir, "hist"),
    });
    applied = true;
  });

  it("HotReload ok:true 分支不抛错", () => {
    expect(applied).toBe(true);
  });

  it("隔离自检：落盘收敛在本块 hist 内（删 historyDir 参数即红）", () => {
    expect(existsSync(join(dir, "hist"))).toBe(true);
  });
});

// 6b) 非法适配器文件 → onReload ok:false → !info.ok 分支
describe("6b) 非法适配器文件 → onReload ok:false", () => {
  let applied: boolean;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-hr-bad-"));
    const badFile = join(dir, "bad.mjs");
    writeFileSync(badFile, `export const version = 2; export const name = "bad";`, "utf8");

    const routes: Array<Record<string, unknown>> = [];
    const ctx = {
      logger: { warn: () => {} },
      webServer: {
        register(route: Record<string, unknown>) {
          routes.push(route);
          return () => {};
        },
      },
      on: onStub,
      llm: {
        listProviders() {
          return [];
        },
      },
      fiber: { state: "active" },
      inject: (deps: unknown, cb: (s: unknown) => void) => {
        cb({ settings: {} });
      },
      effect: (fn: () => unknown) => {
        const d = fn();
        return typeof d === "function" ? d : () => {};
      },
    };
    await apply(ctx as unknown as Parameters<typeof apply>[0], {
      adapter: badFile,
      autoReload: true,
      apiKey: "sk-test",
      apiEndpoint: "http://127.0.0.1:9",
      // 隔离（#768 P1）：复用本块 mkdtemp 目录；不传则回落真实 ~/.dsh 写版本与 trend 目录。
      historyDir: join(dir, "hist"),
    });
    applied = true;
  });

  it("HotReload ok:false 分支不抛错", () => {
    expect(applied).toBe(true);
  });
});

// ---------------------------------------------------------------- 8) warmup/prune 定时器清理（假时钟句柄计数，真断言）

// 时间纪律（testing skill §4）：显式声明 toFake 面，只伪造 setInterval/clearInterval
// （Date/setTimeout 保持真实）。P1 恒真版（`cleared=true` 无条件置位，不抛错即绿）已删，
// 清理事实改由句柄计数钉住：不清 clearInterval 即泄漏，归零断言红。

describe("8) disposer 清理 warmup/prune 定时器（假时钟句柄计数）", () => {
  it("apply 注册定时器 → disposer 后句柄计数归零", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const base = vi.getTimerCount();
      const disposers: Array<() => void> = [];
      const routes: Array<Record<string, unknown>> = [];
      const ctx = {
        logger: { warn: () => {} },
        webServer: {
          register(route: Record<string, unknown>) {
            routes.push(route);
            return () => {};
          },
        },
        on: onStub,
        llm: {
          listProviders() {
            return [];
          },
        },
        fiber: { state: "active" },
        inject: (deps: unknown, cb: (s: unknown) => void) => {
          cb({ settings: {} });
        },
        effect: (fn: () => unknown) => {
          const d = fn();
          if (typeof d === "function") disposers.push(d as () => void);
          return typeof d === "function" ? d : () => {};
        },
      };
      // 隔离（#768 P1）：historyDir 指临时目录，否则回落真实 ~/.dsh
      // （installUpgrade 写 .upgrade-version、TrendTracker 建 trend 目录）。
      const dir = mkdtempSync(join(tmpdir(), "dou-apply-timers-"));
      await apply(ctx as unknown as Parameters<typeof apply>[0], {
        warmupIntervalMs: 60000,
        apiKey: "sk-test",
        apiEndpoint: "http://127.0.0.1:9",
        historyDir: join(dir, "hist"),
      });
      // 非盲 guard：定时器确已注册——恰 3 个句柄（warmup 预热 + prune 清理 + scheduler
      // tick，见 scheduler.ts:54），多一个少一个都先红而非归零断言空过。
      expect(vi.getTimerCount()).toBe(base + 3);
      // 必须 await：disposer 是异步链（await trend.dispose() 后才 scheduler.dispose()），
      // 同步调用会让 scheduler 句柄看起来泄漏（实测 +1 残留即此因）。
      for (const d of disposers) {
        if (typeof d === "function") await d();
      }
      // 真断言：不清 clearInterval 即泄漏，此行红
      expect(vi.getTimerCount()).toBe(base);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ================================================================ #150 二阶段：apply 内部数据面与路由分支

// ---------------------------------------------------------------- #301：apply 内部恢复隔离坏状态且诊断单次可见

describe("#301：apply 内部恢复隔离坏状态且诊断单次可见", () => {
  const cases = [
    { raw: "{broken", marker: "JSON 损坏" },
    { raw: '["not","a","mapping"]', marker: "顶层结构无效" },
  ];
  let backups: string[];
  let warnCounts: number[];
  let healthHit: boolean[];
  let fileMoved: boolean[];
  let backupFound: boolean[];
  let backupRaw: boolean[];

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
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
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

      const health = routes.find((route) => route.path === ROUTES.health) as {
        handler: (req: unknown, res: unknown) => void;
      };
      const response = makeRes();
      health.handler(fakeReq(), response);
      const errors =
        (JSON.parse(response._body()) as { errors?: Array<{ key: string; message: string }> })
          .errors ?? [];
      warnCounts.push(warnings.filter((line) => line.includes(entry.marker)).length);
      healthHit.push(
        errors.some(
          (error) => error.key === "adapter-state" && error.message.includes(entry.marker),
        ),
      );
      fileMoved.push(existsSync(stateFile));
      const backup = readdirSync(historyDir)
        .filter((name) => name.startsWith("adapter-state.json.bak-"))
        .find(
          (name) =>
            !backups.includes(name) && readFileSync(join(historyDir, name), "utf8") === entry.raw,
        );
      backupFound.push(backup !== undefined);
      backups.push(backup ?? "missing");
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch {}
      }
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
  let healthDiagHit: boolean;
  let warnOnce: number;
  let persisted: boolean | undefined;
  let tmpLeft: string[];
  let posixMode: number | undefined;
  let selectCode: number;
  let surfaced: boolean | undefined;
  let writeErrOnce: number;
  let recovered: boolean | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-state-301-apply-"));
    const historyDir = join(dir, "history");
    mkdirSync(historyDir, { recursive: true });
    const stateFile = adapterStateFile(historyDir);
    writeFileSync(stateFile, JSON.stringify({ "ghost-provider": "missing-adapter" }), "utf8");

    const { ctx, routes, disposers } = makeCtx();
    const restoreWarnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      restoreWarnings.push(args.map(String).join(" "));
    };
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
    const health = routes.find((route) => route.path === ROUTES.health) as {
      handler: (req: unknown, res: unknown) => void;
    };
    const select = routes.find((route) => route.path === ROUTES.select) as {
      handler: (req: unknown, res: unknown) => Promise<void>;
    };
    const healthErrors = (): Array<{ key: string; message: string }> => {
      const response = makeRes();
      health.handler(fakeReq(), response);
      return (
        (JSON.parse(response._body()) as { errors?: Array<{ key: string; message: string }> })
          .errors ?? []
      );
    };

    healthDiagHit = healthErrors().some(
      (entry) =>
        entry.key === "adapter-state" &&
        entry.message.includes("missing-adapter") &&
        entry.message.includes("不在当前候选"),
    );
    warnOnce = restoreWarnings.filter(
      (line) => line.includes("missing-adapter") && line.includes("不在当前候选"),
    ).length;

    // 成功路径：发布物实际调度链写出合法 JSON、无 tmp 残留，POSIX 权限为 0600。
    let response = makeRes();
    await select.handler(
      fakeReq({
        method: "POST",
        body: JSON.stringify({
          provider: OPENCODE_GO_PROVIDER,
          adapterName: OPENCODE_GO_ADAPTER_ID,
        }),
      }),
      response,
    );
    persisted = await pollUntil(() => {
      try {
        return (
          JSON.parse(readFileSync(stateFile, "utf8"))[OPENCODE_GO_PROVIDER] ===
          OPENCODE_GO_ADAPTER_ID
        );
      } catch {
        return false;
      }
    });
    tmpLeft = readdirSync(historyDir).filter((name) => name.endsWith(".tmp"));
    posixMode = process.platform !== "win32" ? statSync(stateFile).mode & 0o777 : undefined;

    rmSync(stateFile, { force: true });
    mkdirSync(stateFile); // 旧状态读取稳定报 EISDIR，构造 fail-closed 的持久化错误
    response = makeRes();
    const writeErrors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      writeErrors.push(args.map(String).join(" "));
    };
    surfaced = false;
    try {
      await select.handler(
        fakeReq({
          method: "POST",
          body: JSON.stringify({
            provider: OPENCODE_GO_PROVIDER,
            adapterName: OPENCODE_GO_ADAPTER_ID,
          }),
        }),
        response,
      );
      selectCode = response._code();
      surfaced = await pollUntil(() =>
        healthErrors().some(
          (entry) => entry.key === "adapter-state" && entry.message.includes("启用选择落盘失败"),
        ),
      );
    } finally {
      console.error = originalError;
    }
    writeErrOnce = writeErrors.filter((line) => line.includes("启用选择落盘失败")).length;

    rmSync(stateFile, { recursive: true, force: true });
    response = makeRes();
    await select.handler(
      fakeReq({
        method: "POST",
        body: JSON.stringify({
          provider: OPENCODE_GO_PROVIDER,
          adapterName: OPENCODE_GO_ADAPTER_ID,
        }),
      }),
      response,
    );
    recovered = await pollUntil(() => {
      try {
        return (
          JSON.parse(readFileSync(stateFile, "utf8"))[OPENCODE_GO_PROVIDER] ===
          OPENCODE_GO_ADAPTER_ID
        );
      } catch {
        return false;
      }
    });

    for (const dispose of [...disposers].reverse()) {
      try {
        dispose();
      } catch {}
    }
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

describe.skipIf(process.platform === "win32")(
  "#301：rename 已提交后的目录 fsync 失败仅报耐久性告警",
  () => {
    let selectCode: number;
    let directorySyncAttempts: number;
    let committed: boolean | undefined;
    let surfaced: boolean | undefined;
    let warnOnce: number;
    let writeErrList: string[];
    let healthPolluted: boolean;

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
        return (
          (JSON.parse(response._body()) as { errors?: Array<{ key: string; message: string }> })
            .errors ?? []
        );
      };

      const originalOpen = fs.promises.open;
      directorySyncAttempts = 0;
      fs.promises.open = async (path, flags, ...rest) => {
        if (String(path) === historyDir && flags === "r") {
          directorySyncAttempts += 1;
          const error = new Error(
            "simulated parent directory fsync failure",
          ) as NodeJS.ErrnoException;
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
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };
      console.error = (...args: unknown[]) => {
        writeErrors.push(args.map(String).join(" "));
      };
      const response = makeRes();
      surfaced = false;
      committed = false;
      try {
        await select.handler(
          fakeReq({
            method: "POST",
            body: JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: null }),
          }),
          response,
        );
        selectCode = response._code();
        surfaced = await pollUntil(() =>
          healthErrors().some(
            (entry) => entry.key === "adapter-state" && entry.message.includes("耐久性未完全确认"),
          ),
        );
        committed = await pollUntil(() => {
          try {
            return JSON.parse(readFileSync(stateFile, "utf8"))[OPENCODE_GO_PROVIDER] === null;
          } catch {
            return false;
          }
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

      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch {}
      }
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
  },
);

// ---------------------------------------------------------------- history 数据面（围栏经 integration+smoke 覆盖）
//
// 围栏删测登记（M1）：删围栏四例——stats 路由已注册弱断言、stats 非 loopback 403、
// stats POST 405、history 非 loopback 403。覆盖去向：src 门面层由
// integration/data-routes D10二（403 先于 405 顺序敏感 + 文案逐字节锁定）保留；
// lib 产物层由 smoke 围栏全矩阵（十六路由 403/405 + 文案）保留。保留 history
// existence + 数据面五例（apply 装配经由，门面桩与产物矩阵未覆盖）。

describe("history 数据面（围栏经 integration+smoke 覆盖）", () => {
  let historyR: ReturnType<typeof routeOf>;
  let noAdpBody: { reason: unknown; panelHtml: unknown };
  let okBody: { plugin: unknown; adapterName: unknown; range: { start: unknown } };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-stats-"));
    const goodFile = join(dir, "good.mjs");
    writeFileSync(goodFile, adapterMjs("stats-adp"), "utf8");
    const { ctx, routes } = makeCtx();
    await apply(ctx, {
      adapter: goodFile,
      autoReload: false,
      apiKey: "sk",
      apiEndpoint: "http://127.0.0.1:9",
      historyDir: join(dir, "hist"),
    });

    // history 数据面：无候选 no-adapter / days clamp
    historyR = routeOf(routes, ROUTES.history);

    // 无启用适配器（清空选择后）→ 结构化 no-adapter
    const hNoAdp = makeRes();
    await historyR?.handler(fakeReq({ url: `${ROUTES.history}?provider=ghost` }), hNoAdp);
    noAdpBody = JSON.parse(hNoAdp._body());

    // days 参数：合法窗口取 min(days, maxAgeDays)
    const hDays = makeRes();
    await historyR?.handler(fakeReq({ url: `${ROUTES.history}?days=7` }), hDays);
    okBody = JSON.parse(hDays._body());
  });

  it("history 路由已注册", () => {
    expect(historyR).toBeTruthy();
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
  let savedDshHome: string | undefined;
  let probePairOk: boolean;
  let windowOverlap: boolean;
  let windowDetail: string;
  let bSlow: Record<string, unknown>;
  let bFast: Record<string, unknown>;
  let slowSeqCount: number;
  let landed: boolean | undefined;
  let bNoEn: Record<string, unknown>;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-getstats-"));
    // 隔离 DSH_HOME：避免读到真实环境的 user-adapters.json / adapter-state.json
    savedDshHome = process.env.DSH_HOME;
    process.env.DSH_HOME = join(dir, "dshhome");
    mkdirSync(process.env.DSH_HOME!, { recursive: true });

    // 两个用户适配器（providers 互不相同）：
    // - slow：80ms IO 延迟 + 调用计数（seq 经返回数据透出、formatCapsule 渲染）——
    //   提供「全程仅一次真实取数」的证据载体；
    // - fast：60ms 延迟 + 起止时间戳写 globalThis 探针——提供跨 provider 并行的窗口证据。
    const slowFile = join(dir, "slow.mjs");
    writeFileSync(
      slowFile,
      `
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
`,
      "utf8",
    );
    const fastFile = join(dir, "fast.mjs");
    writeFileSync(
      fastFile,
      `
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
`,
      "utf8",
    );
    // 清单写入 historyRoot（本块显式传了 historyDir → user-adapters.json 从那里读取）
    mkdirSync(join(dir, "hist"), { recursive: true });
    writeFileSync(
      userAdaptersFile(join(dir, "hist")),
      JSON.stringify({
        adapters: [
          { id: "slow-adp", label: "Slow", providers: ["prov-slow"], file: slowFile },
          { id: "fast-adp", label: "Fast", providers: ["prov-fast"], file: fastFile },
        ],
      }),
      "utf8",
    );
    delete (globalThis as unknown as Record<string, unknown>).__pp120;

    try {
      const { ctx, routes, disposers } = makeCtx();
      await apply(ctx, {
        autoReload: false,
        apiKey: "sk",
        apiEndpoint: "http://127.0.0.1:9",
        historyDir: join(dir, "hist"),
      });
      const stats = routeOf(routes, ROUTES.stats) as {
        handler: (req: unknown, res: unknown) => Promise<void>;
      };
      const selectR = routeOf(routes, ROUTES.select) as {
        handler: (req: unknown, res: unknown) => Promise<void>;
      };
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
      const probe = ((globalThis as unknown as Record<string, unknown>).__pp120 ?? []) as Array<{
        n: string;
        t: number;
        k: string;
        seq?: number;
      }>;
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
      await selectR.handler(
        fakeReq({
          method: "POST",
          body: JSON.stringify({ provider: "prov-slow", adapterName: null }),
        }),
        makeRes(),
      );
      bNoEn = await askStats("prov-slow");

      for (const d of [...disposers].reverse()) {
        try {
          d();
        } catch {}
      }
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
// 交错下不再可能把他人 mock 固化为「现场」（unit-chart 慢路径 × 本窗口交错驻留实证）。
describe("fetchWithTimeout 边界（#150 二阶段）", () => {
  let okStatus: number;
  let fastCallsAtLeast1: boolean;
  let okUrl: string;
  let slowCallsAtLeast1: boolean;
  let slowAborted: boolean;
  let defCallsAtLeast1: boolean;

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
      set(async () => {
        defCalls += 1;
        return { status: 204 };
      });
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
  let savedDshHome: string | undefined;
  let noNotifierMounted: boolean;
  let mountedKinds: number;
  let mountedKindsId: string | undefined;
  let mountedKindsLabel: string | undefined;
  let preEventKindCount: number;
  let svcListenerCount: number;
  let postEventKindCount: number;
  let reRegisteredId: string | undefined;

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
    mkdirSync(process.env.DSH_HOME!, { recursive: true });

    const baseCfg = {
      autoReload: false,
      apiKey: "sk-test",
      apiEndpoint: "http://127.0.0.1:9",
      historyDir,
    };

    // 1) ctx 无 get（fake ctx 未提供探测面）：降级不注册、apply 正常挂载不抛
    {
      const { ctx, routes, disposers } = makeCtx();
      await apply(ctx, baseCfg);
      noNotifierMounted = routes.some((r) => r.path === ROUTES.health);
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch {}
      }
    }

    // 2) ctx.get 命中 wingsky.notifier（notifier 已加载）：挂载即注册 provider-usage:report
    {
      const kinds: Array<{ id: string; label: string }> = [];
      const { ctx, disposers } = makeCtx({ get: fakeNotifier(kinds) });
      await apply(ctx, baseCfg);
      mountedKinds = kinds.length;
      mountedKindsId = kinds[0]?.id;
      mountedKindsLabel = kinds[0]?.label;
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch {}
      }
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
      for (const dispose of [...disposers].reverse()) {
        try {
          dispose();
        } catch {}
      }
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
