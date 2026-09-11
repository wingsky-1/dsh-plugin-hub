// @ts-nocheck
/**
 * dsh-provider-usage — 宿主端冒烟测试·集成区（v2 重构版，fake ctx + 注入，无网络）。
 *
 * 覆盖：
 * - apply：enabled:false 不注册；注册四路由（stats/history/health/adapter.mjs）
 * - 全路由 403（非回环）/ 405（方法错）围栏
 * - /stats v2 响应形状（capsuleHtml / status / adapterVersion）
 * - /history v2 响应形状（panelHtml / range）
 * - /health 快照形状
 * - 客户端 bundle 契约面与路由一致性
 *
 * 迁移说明（#722 阶段 1）：原文件为脚本式测试（顶层裸 assert），vitest 会报
 * `No test suite found`。现改为 describe/it 结构，每条断言一个 it。
 * 交错动作纪律：原脚本「动作 → 断言 → 新动作 → 新断言」的顺序在各 describe 的
 * beforeAll 内逐行保留，并在每个原断言位置取观测快照；it 只对快照做断言。
 */
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertClientProductContract, assertClientSourceContract, clientRouteLiterals } from "../../../../test/smoke-lib.ts";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callHandler, pollUntil, pollUntilJsonlReady } from "../helpers.ts";
import { __clearReportIndexCacheForTests, __reportIndexCacheStatsForTests, readReportIndex } from "../../lib/index.js";

// 纯函数断言区先行执行（无 @ts-nocheck、强类型）
import "../smoke-pure.ts";

// 结构化单元测试（#83 阶段一、#670 阶段四目录镜像）由包内 `test/*.test.ts` glob
// 直接执行（#690 S2）；此处不再 import 聚合——聚合会让同一文件在同进程内被求值两遍。

import {
  apply,
  inject,
  ROUTES,
  candidateWindow,
  previousClosedWindow,
  ADAPTER_CONTRACT_VERSION,
  OPENCODE_GO_PROVIDER,
  OPENCODE_GO_ADAPTER_ID,
  DEEPSEEK_OFFICIAL_PROVIDER,
  DEEPSEEK_OFFICIAL_ADAPTER_ID,
  userAdaptersFile,
  adapterStateFile,
  PANEL_CACHE_TTL_MS,
  normalizeRangeDay,
  panelCacheKey,
  isPanelCacheStale,
  dayKey,
  TREND_DIR_MAX,
  HotReloadableAdapter,
} from "../../lib/index.js";

const here = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 热更新确定性驱动
//
// DEVELOPMENT §5.2：e2e 不得以墙钟观察异步行为。热更新生效本由 2s 定时器轮询驱动，
// e2e 里改用显式驱动：lib/index.js 与 apply 共用同一个 HotReloadableAdapter class 对象，
// 原型打桩即可拿到 apply 内部创建的实例，`await pollOnce()` 返回时 reload 已完成
// （registry 已原子切换、缓存已清），断言随即读取路由可见效果，零等待。
const hotReloaders: HotReloadableAdapter[] = [];
const __origHotReloadStart = HotReloadableAdapter.prototype.start;
HotReloadableAdapter.prototype.start = async function (...args) {
  const result = await __origHotReloadStart.apply(this, args);
  hotReloaders.push(this);
  return result;
};

/** 对已登记的被监视文件驱动一次轮询；传 file 时只驱动该文件（返回即热更新已落定）。 */
async function driveHotReloads(file?: string): Promise<void> {
  for (const hr of hotReloaders) {
    if (file === undefined || hr.file === file) await hr.pollOnce();
  }
}

// 全局隔离（红线）：apply 一律落在临时 DSH_HOME，绝不触碰真实 ~/.dsh
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dou-home-"));

// 网络隔离（红线）：清掉可能存在于真实环境的密钥变量，防内置适配器发起真实请求；
// 测试结束后恢复（#198：deepseek 系列密钥一并清空——T2 无真实凭据纪律）。
const SAVED_ENV_KEYS = ["OPENCODE_GO_API_KEY", "OPENCODE_GO_PROVIDER_API_KEY", "DEEPSEEK_API_KEY", "DEEPSEEK_OFFICIAL_API_KEY"];
const savedEnv: Record<string, string | undefined> = {};
for (const k of SAVED_ENV_KEYS) {
  savedEnv[k] = process.env[k];
  delete process.env[k];
}
process.env.OPENCODE_GO_API_KEY_TEST_ABSENT = "1";

// 隔离配置：显式 key（优先级最高，阻断 auth.json/env 真实凭据读取）+
// 不可达回环地址（无外呼，快速 network 失败）。所有 apply 用例必须携带。
const ISOLATED_CONFIG = { apiKey: "sk-smoke-test", apiEndpoint: "http://127.0.0.1:9" };

// ---------------------------------------------------------------- fake ctx + apply

function fakeReq(overrides = {}) {
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    method: "GET",
    url: "/",
    // readJsonBody 用 for await 读 body：提供 async-iterator 桩
    [Symbol.asyncIterator]: async function* () {
      if (typeof overrides.body === "string" && overrides.body !== "") {
        yield Buffer.from(overrides.body);
      }
      // 无 body 或空 → 直接结束（readJsonBody 得到空 → JSON.parse 抛 → 400）
    },
    ...overrides,
  };
  return req;
}

/** #503 M3：报告生成的默认罐头 chunk 流（安全正文 + usage 元数据 + finish）。 */
const DEFAULT_LLM_CHUNKS = [
  { type: "text-delta", index: 0, text: "本周用量平稳，调用集中在工作时段，环比小幅上升。" },
  { type: "usage", usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 } },
  { type: "finish", reason: "stop" },
];

function makeFakeCtx(overrides = {}) {
  // #503 M3：llmStreamChunks 允许用例替换报告生成的产出正文（XSS 净化用例传恶意正文）
  const { llmStreamChunks, ...rest } = overrides;
  const routes = [];
  // #503：事件监听表（ctx.on 注册 / emitEvent 派发）与 effect disposer 收集
  const listeners = new Map();
  const effects = [];
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    llm: {
      listProviders() {
        return [
          { id: "anthropic", name: "Anthropic" },
          { id: OPENCODE_GO_PROVIDER, name: "OpenCode Go" },
        ];
      },
      async listModels(provider) {
        return [{ provider, id: "model-a", name: "Model A" }];
      },
      stream() {
        const chunks = llmStreamChunks ?? DEFAULT_LLM_CHUNKS;
        return (async function* () {
          yield* chunks;
        })();
      },
    },
    effect(fn) {
      const disposer = fn();
      effects.push(typeof disposer === "function" ? disposer : () => {});
      return effects.at(-1);
    },
    on(event, fn) {
      const arr = listeners.get(event) ?? [];
      arr.push(fn);
      listeners.set(event, arr);
      return () => {
        const cur = listeners.get(event) ?? [];
        const i = cur.indexOf(fn);
        if (i >= 0) cur.splice(i, 1);
      };
    },
    ...rest,
  };
  const emitEvent = (event, ...args) => {
    for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
  };
  return { ctx, routes, listeners, effects, emitEvent };
}

// ---------------------------------------------------------------- 测试公共件

const mkSpyFile = (dir, fileBase, name, provider, formatPanelBody, extra = "") => {
  const file = join(dir, `${fileBase}.mjs`);
  writeFileSync(file, `
export const version = 2;
export const name = "${name}";
export const label = "${name}";
export const providers = ["${provider}"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>c</span>"; }
export function formatPanel(input) { ${formatPanelBody} }
${extra}
`, "utf8");
  return file;
};

const countingPanel = (counter) =>
  `globalThis.${counter} = (globalThis.${counter} ?? 0) + 1;` +
  `return "<p data-calls=\\"" + globalThis.${counter} + "\\" data-n=\\"" + input.entries.length + "\\">panel</p>";`;

const makeCollectingCtx = () => {
  const disposers = [];
  const { ctx, routes } = makeFakeCtx({
    effect(fn) {
      const d = fn();
      if (typeof d === "function") disposers.push(d);
      return typeof d === "function" ? d : () => {};
    },
  });
  return { ctx, routes, disposers };
};

const callRoute = (route, reqOverrides) => new Promise((resolve) => {
  let payload;
  route.handler(fakeReq(reqOverrides), {
    writeHead: () => {},
    end: (chunk) => { payload = JSON.parse(chunk); resolve(payload); },
  });
});
const getHistory = (route, provider, days) =>
  callRoute(route, { url: `${ROUTES.history}?provider=${provider}&days=${days}` });
const postJson = (route, body) => callRoute(route, { method: "POST", body: JSON.stringify(body) });

const disposeAll = (disposers) => {
  for (const d of [...disposers].reverse()) { try { d(); } catch { /* 忽略 */ } }
};

// ---------------------------------------------------------------- enabled 开关

describe("enabled 开关", () => {
  let registeredRouteCount;

  beforeAll(async () => {
    const { ctx, routes } = makeFakeCtx();
    await apply(ctx, { enabled: false });
    registeredRouteCount = routes.length;
  });

  it("enabled:false 不注册任何路由", () => {
    expect(registeredRouteCount).toBe(0);
  });
});

// ---------------------------------------------------------------- 注册十六路由

describe("注册十六路由", () => {
  let registeredPaths;
  let allRouteKindsValid;

  beforeAll(async () => {
    const { ctx, routes } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG });
    registeredPaths = routes.map((r) => r.path).sort();
    allRouteKindsValid = routes.every((r) => r.kind === "exact" || r.kind === "prefix");
  });

  it("注册十六条路由（stats/history/trend/adapters.json/select/inspect/add/health/ui-config/events + #503 报告四路由 + #532 模型候选 + #625 生成状态）", () => {
    expect(registeredPaths).toEqual(
      [ROUTES.health, ROUTES.history, ROUTES.stats, ROUTES.trend, ROUTES.adapters, ROUTES.select, ROUTES.inspect, ROUTES.add, ROUTES.uiConfig, ROUTES.events, ROUTES.reportConfig, ROUTES.reportModels, ROUTES.reports, ROUTES.reportDetail, ROUTES.reportGenerate, ROUTES.reportGenerateStatus].sort(),
    );
  });

  it("路由 kind 合法", () => {
    expect(allRouteKindsValid).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 围栏：403 / 405

const POST_ROUTES = new Set([ROUTES.select, ROUTES.inspect, ROUTES.add, ROUTES.uiConfig, ROUTES.reportConfig, ROUTES.reportGenerate]);
const FENCE_ROUTE_PATHS = [ROUTES.stats, ROUTES.history, ROUTES.trend, ROUTES.health, ROUTES.adapters, ROUTES.select, ROUTES.inspect, ROUTES.add, ROUTES.uiConfig, ROUTES.events, ROUTES.reportConfig, ROUTES.reportModels, ROUTES.reports, ROUTES.reportDetail, ROUTES.reportGenerate, ROUTES.reportGenerateStatus];
const FENCE_ROUTE_CASES = FENCE_ROUTE_PATHS.map((routePath) => ({
  routePath,
  wrongMethod: POST_ROUTES.has(routePath) ? "DELETE" : "POST",
  notMethod: POST_ROUTES.has(routePath) ? "POST" : "GET",
}));

describe("围栏：403 / 405", () => {
  /** routePath → 该端点的围栏观测快照 */
  const guardObs = new Map();

  beforeAll(async () => {
    for (const routePath of FENCE_ROUTE_PATHS) {
      const { ctx, routes } = makeFakeCtx();
      await apply(ctx, { ...ISOLATED_CONFIG });
      const route = routes.find((r) => r.path === routePath);
      const obs: Record<string, unknown> = { exists: route !== undefined };
      if (route !== undefined) {
        // 非回环 → 403
        const responses403 = [];
        const res403 = { writeHead: () => {}, end: (chunk) => { responses403.push(JSON.parse(chunk)); } };
        route.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res403);
        obs.forbiddenError = responses403.at(-1)?.error;

        // 方法错 → 405（POST 路由用 DELETE 触发；GET 路由用 POST 触发）
        // #473 批 2（B2-4）：405 body 围栏文案断言（守卫收敛后逐字节锁定，全 10 端点）
        const wrongMethod = POST_ROUTES.has(routePath) ? "DELETE" : "POST";
        const responses405 = [];
        const res405 = { writeHead: (code) => { responses405.push({ __code: code }); }, end: (chunk) => { responses405.push(JSON.parse(chunk)); } };
        route.handler(fakeReq({ method: wrongMethod }), res405);
        obs.code405 = responses405[0]?.__code;
        obs.methodErrorBody = responses405.at(-1)?.error;
      }
      guardObs.set(routePath, obs);
    }
  });

  it.each(FENCE_ROUTE_PATHS)("%s 路由存在", (routePath) => {
    expect(guardObs.get(routePath).exists).toBeTruthy();
  });

  it.each(FENCE_ROUTE_PATHS)("%s 非回环 403", (routePath) => {
    expect(guardObs.get(routePath).forbiddenError).toBe("forbidden: loopback-only");
  });

  it.each(FENCE_ROUTE_CASES)("$routePath 非 $notMethod 405", ({ routePath }) => {
    expect(guardObs.get(routePath).code405).toBe(405);
  });

  it.each(FENCE_ROUTE_CASES)("$routePath 405 body 围栏文案", ({ routePath, wrongMethod }) => {
    expect(guardObs.get(routePath).methodErrorBody).toBe(`method not allowed: ${wrongMethod}`);
  });
});

// ---------------------------------------------------------------- ui-config / events

describe("ui-config / events", () => {
  let bothRoutesExist;
  let getPayload;
  let postPayload;
  let uiFileOnDisk;
  let storedUiConfig;

  beforeAll(async () => {
    const { ctx, routes } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG });
    const uiRoute = routes.find((r) => r.path === ROUTES.uiConfig);
    const evRoute = routes.find((r) => r.path === ROUTES.events);
    bothRoutesExist = uiRoute !== undefined && evRoute !== undefined;

    // GET 返回默认配置
    getPayload = await callHandler(uiRoute, fakeReq({ method: "GET" }));

    // POST 保存：非法 placement 回退默认、offset clamp、落盘 ui.json
    postPayload = await callHandler(
      uiRoute,
      fakeReq({
        method: "POST",
        body: JSON.stringify({ placement: "middle", offsetX: 99999, offsetY: -5, panelOffsetY: 10 }),
      }),
    );

    // ui.json 已落盘（DSH_HOME 隔离目录内）
    const uiFile = join(process.env.DSH_HOME, "dsh-provider-usage", "ui.json");
    uiFileOnDisk = existsSync(uiFile);
    storedUiConfig = JSON.parse(readFileSync(uiFile, "utf8"));
  });

  it("ui-config/events 路由存在", () => {
    expect(bothRoutesExist).toBeTruthy();
  });

  it("ui-config GET ok", () => {
    expect(getPayload.ok).toBe(true);
  });

  it("默认 placement top-right", () => {
    expect(getPayload.ui.placement).toBe("top-right");
  });

  it("ui-config POST ok", () => {
    expect(postPayload.ok).toBe(true);
  });

  it("非法 placement 回退默认", () => {
    expect(postPayload.ui.placement).toBe("top-right");
  });

  it("offsetX clamp 2000", () => {
    expect(postPayload.ui.offsetX).toBe(2000);
  });

  it("offsetY clamp 0", () => {
    expect(postPayload.ui.offsetY).toBe(0);
  });

  it("panelOffsetY 透传", () => {
    expect(postPayload.ui.panelOffsetY).toBe(10);
  });

  it("#128 zIndexBase 缺省归一化默认 40", () => {
    expect(postPayload.ui.zIndexBase).toBe(40);
  });

  it("ui.json 已落盘", () => {
    expect(uiFileOnDisk).toBeTruthy();
  });

  it("落盘值已归一化", () => {
    expect(storedUiConfig.placement).toBe("top-right");
  });

  it("#128 落盘 ui.json 含归一化 zIndexBase", () => {
    expect(storedUiConfig.zIndexBase).toBe(40);
  });
});

// ---------------------------------------------------------------- /stats v2 响应

describe("/stats v2 响应", () => {
  let payload;

  beforeAll(async () => {
    const { ctx, routes } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG });
    // #120 后无「锁忙 busy 占位帧」（busy 短路语义已废除），预热并发请求在
    // per-provider 锁上排队拿真数据帧 → 无需固定 sleep 等预热完成，直接 await handler。
    const stats = routes.find((r) => r.path === ROUTES.stats);
    payload = await callHandler(stats, fakeReq({ url: `${ROUTES.stats}?provider=${OPENCODE_GO_PROVIDER}` }));
  });

  it("响应 plugin 字段", () => {
    expect(payload.plugin).toBe("dsh-provider-usage");
  });

  it("响应带契约版本 v2", () => {
    expect(payload.version).toBe(ADAPTER_CONTRACT_VERSION);
  });

  it("响应 provider 字段", () => {
    expect(payload.provider).toBe(OPENCODE_GO_PROVIDER);
  });

  it("内置适配器名", () => {
    expect(payload.adapterName).toBe(OPENCODE_GO_ADAPTER_ID);
  });

  it("status 合法", () => {
    expect(["fresh", "cached", "stale"], `实际 ${payload.status}`).toContain(payload.status);
  });

  it("响应带 adapterVersion", () => {
    expect(typeof payload.adapterVersion === "number").toBeTruthy();
  });

  it("不可达端点 → ok 降级为 false 但不崩溃", () => {
    expect(payload.ok).toBe(false);
  });

  it("错误态应有 error 字段", () => {
    expect(payload.error !== null && payload.error !== undefined, `实际 ${JSON.stringify(payload.error)}`).toBeTruthy();
  });
});

// ---------------------------------------------------------------- /history v2 响应

describe("/history v2 响应", () => {
  let payload;

  beforeAll(async () => {
    const { ctx, routes } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG });
    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    payload = await callHandler(historyRoute, fakeReq({ url: `${ROUTES.history}?provider=${OPENCODE_GO_PROVIDER}&days=7` }));
  });

  it("history 响应 plugin 字段", () => {
    expect(payload.plugin).toBe("dsh-provider-usage");
  });

  it("history 响应带契约版本", () => {
    expect(payload.version).toBe(ADAPTER_CONTRACT_VERSION);
  });

  it("history 响应 provider 字段", () => {
    expect(payload.provider).toBe(OPENCODE_GO_PROVIDER);
  });

  it("history 响应 adapterName", () => {
    expect(payload.adapterName).toBe(OPENCODE_GO_ADAPTER_ID);
  });

  it("range 形状合法", () => {
    expect(payload.range && typeof payload.range.start === "number").toBeTruthy();
  });
});

// ---------------------------------------------------------------- /health 响应

describe("/health 响应", () => {
  let payload;

  beforeAll(async () => {
    const { ctx, routes } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG });
    const health = routes.find((r) => r.path === ROUTES.health);
    payload = await callHandler(health, fakeReq());
  });

  it("/health ok", () => {
    expect(payload.ok).toBe(true);
  });

  it("/health 带契约版本", () => {
    expect(payload.version).toBe(ADAPTER_CONTRACT_VERSION);
  });

  it("adapters 列表存在", () => {
    expect(Array.isArray(payload.adapters)).toBeTruthy();
  });

  it("errors 登记表存在", () => {
    expect(Array.isArray(payload.errors)).toBeTruthy();
  });

  it("内置 opencode-go 已注册", () => {
    expect(payload.adapters.some((a) => a.name === OPENCODE_GO_ADAPTER_ID)).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 用户适配器加载（fail-fast）

describe("用户适配器加载（fail-fast）", () => {
  let badAdapterErrorRegistered;
  let userAdapterAdapterName;
  let userAdapterStatus;

  beforeAll(async () => {
    // 写一个非法适配器文件
    const dir = mkdtempSync(join(tmpdir(), "dou-user-"));
    const badFile = join(dir, "bad.mjs");
    writeFileSync(badFile, `export const version = 2; export const name = "bad";`, "utf8");

    const { ctx, routes } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG, adapter: badFile });
    const health = routes.find((r) => r.path === ROUTES.health);
    const payload = await callHandler(health, fakeReq());

    // fail-fast：非法适配器被拒收并登记错误，插件本身不崩溃
    badAdapterErrorRegistered = payload.errors.some((e) => e.kind === "load" && e.message.includes("契约校验失败"));

    // 合法适配器
    const goodFile = join(dir, "good.mjs");
    writeFileSync(goodFile, `
export const version = 2;
export const name = "good-stats";
export const label = "Good";
export const providers = ["${OPENCODE_GO_PROVIDER}"];
export async function fetchData() { return { visits: 42 }; }
export function formatCapsule(input) { return "<span>" + input.data.visits + "</span>"; }
export function formatPanel() { return "<p>ok</p>"; }
`, "utf8");

    const ctx2 = makeFakeCtx();
    await apply(ctx2.ctx, { ...ISOLATED_CONFIG, adapter: goodFile, provider: OPENCODE_GO_PROVIDER });
    const stats = ctx2.routes.find((r) => r.path === ROUTES.stats);
    const p2 = await callHandler(stats, fakeReq({ url: `${ROUTES.stats}?provider=${OPENCODE_GO_PROVIDER}` }));

    // #120：per-provider 锁 + 锁内二次 cacheFresh 校验后，与启动预热并发的请求在锁上
    // 排队并复用首次取数结果（fresh/cached 真数据帧）；旧实现「锁忙 → busy → stale
    // 占位帧」语义已废除。缺 API key 时 resolveProviderConfig 无 key，但用户适配器
    // 自行决定不依赖 key（此处直接返回 42）→ fresh 或其缓存命中 cached。
    userAdapterAdapterName = p2.adapterName;
    userAdapterStatus = p2.status;
  });

  it("非法适配器加载失败应登记 load 错误", () => {
    expect(badAdapterErrorRegistered).toBeTruthy();
  });

  it("用户适配器生效", () => {
    expect(userAdapterAdapterName).toBe("good-stats");
  });

  it("并发期请求拿真数据帧", () => {
    expect(["fresh", "cached"], `实际 ${userAdapterStatus}`).toContain(userAdapterStatus);
  });

  it("不再产生 busy 占位帧", () => {
    expect(userAdapterStatus).not.toBe("stale");
  });
});

// ---------------------------------------------------------------- 卸载清理不抛错

describe("卸载清理不抛错", () => {
  let unloadCompleted;

  beforeAll(async () => {
    const disposers = [];
    const { ctx, routes } = makeFakeCtx({
      effect(fn) {
        const d = fn();
        disposers.push(d);
        return typeof d === "function" ? d : () => {};
      },
    });
    await apply(ctx, { ...ISOLATED_CONFIG });
    for (const d of disposers) {
      if (typeof d === "function") d(); // 不应抛错
    }
    unloadCompleted = true;
  });

  it("卸载清理链路正常", () => {
    expect(unloadCompleted).toBeTruthy();
  });
});

// ---------------------------------------------------------------- adapters.json / select / inspect / add

describe("adapters.json / select / inspect / add", () => {
  const obs = {
    initialVersion: undefined,
    initialHostHasBuiltin: undefined,
    initialModelProvidersIsArray: undefined,
    initialEnabled: undefined,
    inspectOk: undefined,
    inspectName: undefined,
    inspectProviders: undefined,
    badInspectError: undefined,
    badInspectDetail: undefined,
    relativeInspectError: undefined,
    nonJsInspectError: undefined,
    addOk: undefined,
    addName: undefined,
    addEnabled: undefined,
    hostLengthAfterAdd: undefined,
    duplicateAddError: undefined,
    hotReloaded: undefined,
    manageStatsStillEnabled: undefined,
    noFakeHotReloadError: undefined,
    selectOk: undefined,
    selectEnabled: undefined,
    clearSelectOk: undefined,
    clearSelectEnabled: undefined,
    clearSelectCacheSize: undefined,
    clearedStatsReason: undefined,
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-adapter-manage-"));
    const goodFile = join(dir, "manage.mjs");
    writeFileSync(goodFile, `
export const version = 2;
export const name = "manage-stats";
export const label = "管理测试";
export const providers = ["opencode-go"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>x</span>"; }
export function formatPanel() { return "<p>p</p>"; }
`, "utf8");

    const { ctx, routes } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG });
    const withBody = (body: string) => fakeReq({ method: "POST", body });

    // adapters.json：初始含内置适配器 + modelProviders
    {
      const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
      const payload = await callHandler(adaptersRoute, fakeReq());
      obs.initialVersion = payload.version;
      obs.initialHostHasBuiltin = payload.host.some((a) => a.name === OPENCODE_GO_ADAPTER_ID);
      obs.initialModelProvidersIsArray = Array.isArray(payload.modelProviders);
      obs.initialEnabled = payload.enabled[OPENCODE_GO_PROVIDER] === OPENCODE_GO_ADAPTER_ID;
    }

    // inspect：合法文件回显导出信息（不注册）
    {
      const inspectRoute = routes.find((r) => r.path === ROUTES.inspect);
      const payload = await callHandler(inspectRoute, withBody(JSON.stringify({ file: goodFile })));
      obs.inspectOk = payload.ok;
      obs.inspectName = payload.adapter.name;
      obs.inspectProviders = payload.adapter.providers;
    }

    // inspect：非法文件 → 422 + 可排障 detail
    {
      const badFile = join(dir, "bad.mjs");
      writeFileSync(badFile, `export const version = 2; export const name = "only-name";`, "utf8");
      const inspectRoute = routes.find((r) => r.path === ROUTES.inspect);
      const payload = await callHandler(inspectRoute, withBody(JSON.stringify({ file: badFile })));
      obs.badInspectError = payload.error;
      obs.badInspectDetail = payload.detail;
    }

    // inspect：未规整相对路径（../ 穿越形态）→ 400 invalid-file
    {
      const inspectRoute = routes.find((r) => r.path === ROUTES.inspect);
      const payload = await callHandler(inspectRoute, withBody(JSON.stringify({ file: "../evil.mjs" })));
      obs.relativeInspectError = payload.error;
    }

    // inspect：绝对路径但非 JS（如 /etc/passwd）→ 加载失败（本地可信，不做路径拒绝，
    // 但 import 阶段失败登记 adapter-load-failed）
    {
      const inspectRoute = routes.find((r) => r.path === ROUTES.inspect);
      const payload = await callHandler(inspectRoute, withBody(JSON.stringify({ file: "/etc/hostname" })));
      obs.nonJsInspectError = payload.error;
    }

    // add：成功登记 + 成为启用者 + 持久化到 user-adapters.json
    {
      const addRoute = routes.find((r) => r.path === ROUTES.add);
      const payload = await callHandler(addRoute, withBody(JSON.stringify({ file: goodFile })));
      obs.addOk = payload.ok;
      obs.addName = payload.adapter.name;
      obs.addEnabled = payload.enabled[OPENCODE_GO_PROVIDER] === "manage-stats";

      // adapters.json 现在有四条候选（三个内置 + 用户；#198 新增 deepseek-official-builtin、
      // #215 新增 zai-coding-cn-builtin）
      const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
      const meta = await callHandler(adaptersRoute, fakeReq());
      obs.hostLengthAfterAdd = meta.host.length;
    }

    // add：重复 name → 409
    {
      const addRoute = routes.find((r) => r.path === ROUTES.add);
      const payload = await callHandler(addRoute, withBody(JSON.stringify({ file: goodFile })));
      obs.duplicateAddError = payload.error;
    }

    // issue #206：add 后建立的适配器文件也纳入热更新监视——改文件 → 轮询周期内热更新生效
    // #212 回归：成功不再伪装 error 记录（旧实现把「热更新成功」写进 health errors），
    // 改以 adapters.json 中新版 label 可观测生效为准，并断言 errors 无「热更新成功」、enabled 保持。
    {
      const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
      const healthRoute = routes.find((r) => r.path === ROUTES.health);
      const readAdapters = async (): Promise<{ host: Array<{ name: string; label: string; file: string | null; enabled: boolean }>; enabled: Record<string, string>; errors: Array<{ key: string; message: string }> }> =>
        callHandler(adaptersRoute, fakeReq());
      const readHealth = async (): Promise<Array<{ key: string; message: string }>> => {
        const p = await callHandler(healthRoute, fakeReq());
        return p?.errors ?? [];
      };
      // 改文件（label 文案变化，mtime+size 均变）
      writeFileSync(goodFile, `
export const version = 2;
export const name = "manage-stats";
export const label = "管理测试二版";
export const providers = ["opencode-go"];
export async function fetchData() { return { v: 2 }; }
export function formatCapsule() { return "<span>v2</span>"; }
export function formatPanel() { return "<p>p2</p>"; }
`, "utf8");
      // 确定性驱动一次轮询（add 已把该文件纳入监视）——返回即热更新落定，不观察墙钟
      await driveHotReloads(goodFile);
      const snap = await readAdapters();
      obs.hotReloaded = snap.host.some((a) => a.name === "manage-stats" && a.label === "管理测试二版");
      obs.manageStatsStillEnabled = snap.host.find((a) => a.name === "manage-stats")?.enabled;
      const errors = await readHealth();
      obs.noFakeHotReloadError = !errors.some((e) => e.message.includes("热更新成功"));
    }

    // select：切换回内置
    {
      const selectRoute = routes.find((r) => r.path === ROUTES.select);
      const payload = await callHandler(selectRoute, withBody(JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: OPENCODE_GO_ADAPTER_ID })));
      obs.selectOk = payload.ok;
      const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
      const meta = await callHandler(adaptersRoute, fakeReq());
      obs.selectEnabled = meta.enabled[OPENCODE_GO_PROVIDER] === OPENCODE_GO_ADAPTER_ID;
      // 等后台预热完成：select 切回内置会 fire-and-forget 预热（异步写失败帧进缓存）。
      // 若不等它落定，后续 select 清空后再查 /stats 会命中预热残留帧（fetch-failed）
      // 而非 no-enabled-adapter。以 health.cacheSize ≥ 1 为预热帧已写入缓存的就绪信号。
      const healthRoute = routes.find((r) => r.path === ROUTES.health);
      await pollUntil(async () => {
        const h = await callHandler(healthRoute, fakeReq());
        return h?.cacheSize >= 1 ? h : undefined;
      }, 4000, 50);
    }

    // select：清空（null）→ 该 provider 无启用
    {
      const selectRoute = routes.find((r) => r.path === ROUTES.select);
      const payload = await callHandler(selectRoute, withBody(JSON.stringify({ provider: OPENCODE_GO_PROVIDER, adapterName: null })));
      obs.clearSelectOk = payload.ok;
      const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
      const meta = await callHandler(adaptersRoute, fakeReq());
      obs.clearSelectEnabled = meta.enabled[OPENCODE_GO_PROVIDER];

      // D7 S1 扩展：清空 select 走 purgeAllCaches（generation 失效收口）→ 缓存归零。
      // 必须在此断言——紧随的 /stats 请求会写 no-enabled-adapter 错误帧回缓存（既有设计）。
      const healthRoute = routes.find((r) => r.path === ROUTES.health);
      const h = await callHandler(healthRoute, fakeReq());
      obs.clearSelectCacheSize = h.cacheSize;

      // 清空后 /stats 返回 no-enabled-adapter（默认 provider 已被清空）
      const stats = routes.find((r) => r.path === ROUTES.stats);
      const s = await callHandler(stats, fakeReq({ url: `${ROUTES.stats}?provider=${OPENCODE_GO_PROVIDER}` }));
      obs.clearedStatsReason = s.reason;
    }
  });

  it("adapters.json 带契约版本 v2", () => {
    expect(obs.initialVersion).toBe(2);
  });

  it("内置 opencode-go 在候选列表", () => {
    expect(obs.initialHostHasBuiltin).toBeTruthy();
  });

  it("modelProviders 来自 llm 服务", () => {
    expect(obs.initialModelProvidersIsArray).toBeTruthy();
  });

  it("内置默认启用", () => {
    expect(obs.initialEnabled).toBeTruthy();
  });

  it("inspect 合法文件 ok", () => {
    expect(obs.inspectOk).toBe(true);
  });

  it("inspect 回显 name", () => {
    expect(obs.inspectName).toBe("manage-stats");
  });

  it("inspect 回显 providers", () => {
    expect(obs.inspectProviders).toEqual(["opencode-go"]);
  });

  it("非法文件 inspect 返回 invalid-adapter", () => {
    expect(obs.badInspectError).toBe("invalid-adapter");
  });

  it("detail 含可排障信息", () => {
    expect(obs.badInspectDetail.includes("契约校验失败")).toBeTruthy();
  });

  it("未规整相对路径 inspect 400", () => {
    expect(obs.relativeInspectError).toBe("invalid-file");
  });

  it("非 JS 文件加载失败", () => {
    expect(["adapter-load-failed", "invalid-adapter", "invalid-file"], `实际 ${obs.nonJsInspectError}`).toContain(obs.nonJsInspectError);
  });

  it("add 成功", () => {
    expect(obs.addOk).toBe(true);
  });

  it("add 回显 adapter.name", () => {
    expect(obs.addName).toBe("manage-stats");
  });

  it("新增适配器成为该 provider 启用者", () => {
    expect(obs.addEnabled).toBeTruthy();
  });

  it("候选列表含三个内置 + 用户", () => {
    expect(obs.hostLengthAfterAdd).toBe(4);
  });

  it("重复 name add 409", () => {
    expect(obs.duplicateAddError).toBe("duplicate-name");
  });

  it("add 后修改文件应触发热更新且新版代码生效（issue #206）", () => {
    expect(obs.hotReloaded).toBeTruthy();
  });

  it("热更新不改写启用关系：add 时成为的启用者保持启用（#212-A）", () => {
    expect(obs.manageStatsStillEnabled).toBe(true);
  });

  it("成功不得伪装为 error 记录（#212 日志真实）", () => {
    expect(obs.noFakeHotReloadError).toBeTruthy();
  });

  it("select 成功", () => {
    expect(obs.selectOk).toBe(true);
  });

  it("切换回内置生效", () => {
    expect(obs.selectEnabled).toBeTruthy();
  });

  it("清空 select 成功", () => {
    expect(obs.clearSelectOk).toBe(true);
  });

  it("清空后无启用", () => {
    expect(obs.clearSelectEnabled).toBe(undefined);
  });

  it("清空 select 后缓存归零（purgeAllCaches 收口）", () => {
    expect(obs.clearSelectCacheSize).toBe(0);
  });

  it("有候选但清空 → no-enabled-adapter", () => {
    expect(obs.clearedStatsReason).toBe("no-enabled-adapter");
  });
});

// ---------------------------------------------------------------- #212-A：热更新不改写 enabled 且持久化

describe("#212-A：热更新不改写 enabled 且持久化", () => {
  let explicitDisableOk;
  let hotReloadedWhileDisabled;
  let disabledStaysDisabled;
  let providerHasNoEnabled;
  let persistedDisabledState;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-212-a-"));
    const histDir = join(dir, "hist");
    const aFile = join(dir, "a.mjs");
    writeFileSync(aFile, `
export const version = 2;
export const name = "p212-a";
export const label = "A v1";
export const providers = ["p212"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>a1</span>"; }
export function formatPanel() { return "<p>a1</p>"; }
`, "utf8");
    const { ctx, routes } = makeFakeCtx();
    mkdirSync(histDir, { recursive: true }); // 清单/状态落盘目录（消除 warmup 时序依赖，对齐 #212-B）
    await apply(ctx, { ...ISOLATED_CONFIG, provider: "p212", adapter: aFile, historyDir: histDir });
    // 启动稳定：apply 末尾 warmupFn() 启动即预热采样（fire-and-forget），预热成功帧会
    // 落盘历史 jsonl → 以「p212-a 历史目录出现 jsonl」为就绪信号，不用固定 sleep 等启动。
    await pollUntil(() => {
      try { return readdirSync(join(histDir, "p212", "p212-a")).some((f) => f.endsWith(".jsonl")); } catch { return false; }
    }, 4000, 50);

    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    const selectRoute = routes.find((r) => r.path === ROUTES.select);
    const readAdapters = async (): Promise<{ host: Array<{ name: string; label: string; enabled: boolean }>; enabled: Record<string, string> }> =>
      callHandler(adaptersRoute, fakeReq());
    // 用户显式停用（select provider null）
    {
      const payload = await callHandler(selectRoute, fakeReq({ method: "POST", body: JSON.stringify({ provider: "p212", adapterName: null }) }));
      explicitDisableOk = payload.ok;
    }
    // 改文件触发热更新（label 变化可观测新版生效）
    writeFileSync(aFile, `
export const version = 2;
export const name = "p212-a";
export const label = "A v2";
export const providers = ["p212"];
export async function fetchData() { return { v: 2 }; }
export function formatCapsule() { return "<span>a2</span>"; }
export function formatPanel() { return "<p>a2</p>"; }
// v2 marker —— 内容长度变化保证 stamp 可检出
`, "utf8");
    // 确定性驱动一次轮询（该文件由 config.adapter 纳入监视）——返回即热更新落定
    await driveHotReloads(aFile);
    const snap = await readAdapters();
    hotReloadedWhileDisabled = snap.host.some((a) => a.name === "p212-a" && a.label === "A v2");
    disabledStaysDisabled = snap.host.find((a) => a.name === "p212-a")?.enabled;
    providerHasNoEnabled = snap.enabled.p212;
    // 持久化：adapter-state.json 轮询等待落盘 null（scheduleWriteAdapterState 为异步串行链）
    let persisted = false;
    const stateFile = adapterStateFile(histDir);
    const persistDeadline = Date.now() + 3000;
    while (Date.now() < persistDeadline) {
      if (existsSync(stateFile)) {
        try {
          const st = JSON.parse(readFileSync(stateFile, "utf8"));
          if (st.p212 === null) { persisted = true; break; }
        } catch { /* 写入中途，继续轮询 */ }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    persistedDisabledState = persisted;
  });

  it("显式停用成功", () => {
    expect(explicitDisableOk).toBe(true);
  });

  it("停用的适配器文件编辑后热更新生效", () => {
    expect(hotReloadedWhileDisabled).toBeTruthy();
  });

  it("停用的适配器热更新后保持停用，不得静默变回启用（#212-A）", () => {
    expect(disabledStaysDisabled).toBe(false);
  });

  it("provider 保持无启用者", () => {
    expect(providerHasNoEnabled).toBe(undefined);
  });

  it("热更新后的启用关系已持久化到 adapter-state.json（#212-A）", () => {
    expect(persistedDisabledState).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #212-B：改名撞名 → 冲突报错 + 旧条目保留 + 无假成功

describe("#212-B：改名撞名 → 冲突报错 + 旧条目保留 + 无假成功", () => {
  let secondAdapterRegistered;
  let conflictErrorVisible;
  let oneEntryRetained;
  let existingUTwoIntact;
  let noFakeHotReloadSuccess;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-212-b-"));
    const histDir = join(dir, "hist");
    const f1 = join(dir, "one.mjs");   // 经 config.adapter 登记
    const f2 = join(dir, "two.mjs");   // 经 add 路由登记
    writeFileSync(f1, `
export const version = 2;
export const name = "u-one";
export const label = "One v1";
export const providers = ["p212b"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>1</span>"; }
export function formatPanel() { return "<p>1</p>"; }
`, "utf8");
    writeFileSync(f2, `
export const version = 2;
export const name = "u-two";
export const label = "Two v1";
export const providers = ["p212c"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>2</span>"; }
export function formatPanel() { return "<p>2</p>"; }
`, "utf8");
    const { ctx, routes } = makeFakeCtx();
    mkdirSync(histDir, { recursive: true }); // 清单/状态落盘目录（生产由插件 home 保证存在）
    await apply(ctx, { ...ISOLATED_CONFIG, adapter: f1, historyDir: histDir });
    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    const healthRoute = routes.find((r) => r.path === ROUTES.health);
    const addRoute = routes.find((r) => r.path === ROUTES.add);
    // add 登记第二个文件（纳入热更监视）
    {
      // #313：async handler 必须 await（writeJson 在 resolve 前同步调用 end 回调）——
      // 旧「固定 sleep(80ms) 后读 payload」在 CI 慢 runner 下偶发 undefined 崩。
      // 统一走 callHandler（async handler await、同步 handler 立即返回）。
      const payload = await callHandler(addRoute, fakeReq({ method: "POST", body: JSON.stringify({ file: f2 }) }));
      secondAdapterRegistered = payload?.ok;
    }
    // 把 one.mjs 的导出 name 改为 u-two（与另一 user-file 撞名）→ 触发热更冲突路径
    writeFileSync(f1, `
export const version = 2;
export const name = "u-two";
export const label = "One renamed";
export const providers = ["p212b"];
export async function fetchData() { return { v: 2 }; }
export function formatCapsule() { return "<span>x</span>"; }
export function formatPanel() { return "<p>x</p>"; }
// rename marker —— 内容长度变化保证 stamp 可检出
`, "utf8");
    // 确定性驱动一次轮询：改名撞名的冲突判定在 onReload 内同步登记到 registry
    await driveHotReloads(f1);
    const p = await callHandler(healthRoute, fakeReq());
    conflictErrorVisible = (p?.errors ?? []).some((e) => e.kind === "load" && e.message.includes("热更新失败") && e.message.includes("u-two"));
    // 旧条目保留：one.mjs 仍以旧名 u-one 在候选列表，u-two 归属不变
    const meta = await callHandler(adaptersRoute, fakeReq());
    const oneEntry = meta.host.find((a) => a.file === "one.mjs");
    oneEntryRetained = oneEntry !== undefined && oneEntry.name === "u-one";
    existingUTwoIntact = meta.host.some((a) => a.name === "u-two" && a.file === "two.mjs");
    noFakeHotReloadSuccess = !meta.errors.some((e) => e.message.includes("热更新成功"));
  });

  it("第二个适配器登记成功", () => {
    expect(secondAdapterRegistered).toBe(true);
  });

  it("改名撞名应产生明确的冲突报错且 health 可见（#212-B）", () => {
    expect(conflictErrorVisible).toBeTruthy();
  });

  it("撞名后 one.mjs 旧条目保留、未静默丢失（#212-B）", () => {
    expect(oneEntryRetained).toBeTruthy();
  });

  it("既有 u-two 条目不受牵连", () => {
    expect(existingUTwoIntact).toBeTruthy();
  });

  it("不得出现假「热更新成功」记录（#212-B）", () => {
    expect(noFakeHotReloadSuccess).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 客户端契约

/** 客户端契约断言使用的文件/派生观测（beforeAll 一次性读取，it 只做断言） */
const clientContractObs: Record<string, any> = {};

describe("客户端契约", () => {
  beforeAll(() => {
    const pkgDir = join(here, "..", "..");
    clientContractObs.pkgDir = pkgDir;

    // #633 修复：inject 契约断言——apply 的 resolveCwd 经 ctx.sessions.get(id)?.header.cwd
    // 取会话工作目录，故 `sessions` 必须在插件 inject 声明中。cordis 4 对未声明服务的属性
    // 直访抛错，而 resolveCwd 的 catch 会把它吞成 undefined → 目录维度静默全失效（实测：
    // 2494 行全部落未识别桶、历史柱全空）。此断言锁定声明，防再次漏项。
    const hostCode = readFileSync(join(pkgDir, "lib", "index.js"), "utf8");
    clientContractObs.hostCode = hostCode;

    // #524：客户端产物路由字面量与 ROUTES 全集严格一致断言（纵深防御 fallback 漂移）
    const clientCode = readFileSync(join(pkgDir, "lib", "client.js"), "utf8");
    clientContractObs.clientCode = clientCode;
    clientContractObs.extractedRouteLiterals = clientRouteLiterals(
      clientCode,
      "[\"'`](/api/dsh-provider-usage/[a-zA-Z0-9_/.-]+)[\"'`]",
    );

    // i18n 接入哨兵（issue #348）：NS / register / bind / slots locale 参数 / 双语字典进产物
    const client = clientCode;

    // 客户端源码为干净模块（只 export apply/inject，无 loader 痕迹）
    const clientSource = readFileSync(join(pkgDir, "src/client/index.tsx"), "utf8");
    clientContractObs.clientSource = clientSource;
    clientContractObs.injectLine = clientSource.match(/export const inject[^\n]*/)?.[0] ?? "";

    // #383 追加根因：modelSelection 投影读取必须 next 优先（看宿主 view 语义
    // next = pending ?? lastUsed——会话内切模型只更新 next，lastUsed 等真发请求才随动；
    // 读 lastUsed 优先会造成「切模型胶囊不跟随」，回归防线放契约层）
    const coreSource = readFileSync(join(pkgDir, "src/client/core.ts"), "utf8");
    clientContractObs.projectionReadLine = coreSource.split("\n").find((l) => l.includes("?.next ?? ms?.lastUsed") || l.includes("ms?.lastUsed ?? ms?.next"));

    // #629 P2：手动生成轮询路径 executor 侧幂等复用与 200 直接复用路径提示对称——
    // pollReportTask 返回 reused 且轮询分支经 setGenNotice(t("reportReused")) 渲染提示
    const reportSource = readFileSync(join(pkgDir, "src/client/report.tsx"), "utf8");
    clientContractObs.pollRetMatch = reportSource.match(/return \{ meta: body\.meta, reused: body\.reused === true \};/);
    clientContractObs.pollCallMatch = reportSource.match(/const polled = await pollReportTask\(/);
    clientContractObs.noticeMatch = reportSource.match(/setGenNotice\(polledReused \? t\("reportReused"\) : null\);/);
    clientContractObs.directMatch = reportSource.match(/if \(body\.reused === true\) setGenNotice\(t\("reportReused"\)\);/);

    // qa F1（#128 实测）：bottom-* 锚点首次打开以小高度定位、异步数据撑高面板后
    // 无重排路径 → 稳定向下溢出视口。防回归：renderPanel 尾部触发重定位 +
    // toggleFloat 先渲染后定位。
    clientContractObs.renderPanelRelocates = /function renderPanel[\s\S]*?if \(floatOpen\) applyUiPlacement\(\);/.test(clientSource);
    {
      const tfStart = clientSource.indexOf("function toggleFloat");
      const tf = clientSource.slice(tfStart);
      clientContractObs.toggleFloatOrderOk = tf.indexOf("renderPanel()") >= 0 && tf.indexOf("renderPanel()") < tf.indexOf("placePanel()");
    }

    // lib/index.js 导出 v2 契约面
    clientContractObs.hostLib = readFileSync(join(pkgDir, "lib/index.js"), "utf8");

    // #532 设置页多 tab 契约：分段器结构与窗格 keep-mounted 语义进产物/源码
    clientContractObs.clientBundle = clientCode;
    const settingsIndex = readFileSync(join(pkgDir, "src/client/settings/index.tsx"), "utf8");
    clientContractObs.settingsIndex = settingsIndex;

    // ---- 观测快照（原始断言位置的取值）----
    clientContractObs.injectIsArray = Array.isArray(inject);
    clientContractObs.injectIncludesSessions = inject.includes("sessions");
    clientContractObs.clientIncludesProviderUsageNs = client.includes('"providerUsage"');
    clientContractObs.clientIncludesLocaleRegister = client.includes("locale.register");
    clientContractObs.clientIncludesBindLocale = client.includes("bindLocale");
    clientContractObs.clientIncludesSlotsLocale = client.includes("locale: NS");
    clientContractObs.clientIncludesBilingualDict = client.includes("just now") && client.includes("justNow");
    clientContractObs.clientSourceHasNoLoader = !clientSource.includes("__ModuleLoader__");
    clientContractObs.clientSourceExportsApply = clientSource.includes("export function apply");
    clientContractObs.clientSourceHasNoCtxGet = !/ctx\.get\(["']/.test(clientSource);
    clientContractObs.clientSourceHasNoMcpClearance = !clientSource.includes("mcpClearance");
    clientContractObs.clientSourceHasNoMcpFloatProbe = !clientSource.includes("data-dsh-mcp-float");
    clientContractObs.clientSourceUsesFixed = clientSource.includes('.style.position = "fixed"');
    clientContractObs.clientSourceHasNoEventSource = !clientSource.includes("new EventSource(");
    clientContractObs.clientSourceHasSyncUiConfig = clientSource.includes("syncUiConfig");
    clientContractObs.settingsHasKeepMounted = settingsIndex.includes('className="dou-set-pane"') && settingsIndex.includes("hidden={tab !== key}");
    clientContractObs.settingsHasNoUrlOrStorageState = !/location\.hash|sessionStorage\.|localStorage\./.test(settingsIndex);
    clientContractObs.bundleHasSetTabClasses = clientCode.includes("dou-set-tab") && clientCode.includes("dou-set-pane");
    clientContractObs.settingsHasRoleGroup = settingsIndex.includes('role="group"');
    clientContractObs.settingsHasNoRoleNavigation = !settingsIndex.includes('role="navigation"');
    clientContractObs.settingsNavLabelI18n = settingsIndex.includes('t("settingsNavLabel")');
  });

  it("客户端源码契约（assertClientSourceContract）", () => {
    assertClientSourceContract(clientContractObs.pkgDir);
  });

  it("客户端产物契约（assertClientProductContract）", () => {
    assertClientProductContract(clientContractObs.pkgDir);
  });

  it("插件导出 inject 数组", () => {
    expect(clientContractObs.injectIsArray).toBeTruthy();
  });

  it("inject 必须声明 sessions（目录维度归属主源的访问前提）", () => {
    expect(clientContractObs.injectIncludesSessions).toBeTruthy();
  });

  it.each(["webServer", "llm"])("inject 保留既有声明 %s", (required) => {
    expect(inject.includes(required)).toBeTruthy();
  });

  it("lib 产物 inject 声明含 sessions", () => {
    expect(clientContractObs.hostCode).toMatch(/var inject = \[[^\]]*"sessions"[^\]]*\]/);
  });

  it("客户端产物路由字面量必须与 ROUTES 全集严格完全一致（无缺失、无多余）", () => {
    expect(clientContractObs.extractedRouteLiterals.sort()).toEqual(Object.values(ROUTES).sort());
  });

  it("i18n 命名空间 NS 进产物", () => {
    expect(clientContractObs.clientIncludesProviderUsageNs).toBeTruthy();
  });

  it("locale.register（字典注册）进产物", () => {
    expect(clientContractObs.clientIncludesLocaleRegister).toBeTruthy();
  });

  it("bindLocale（t 活绑定装配）进产物", () => {
    expect(clientContractObs.clientIncludesBindLocale).toBeTruthy();
  });

  it("slots.register locale 参数进产物", () => {
    expect(clientContractObs.clientIncludesSlotsLocale).toBeTruthy();
  });

  it("en/zh 双语字典进产物", () => {
    expect(clientContractObs.clientIncludesBilingualDict).toBeTruthy();
  });

  it("客户端源码不得含 loader 痕迹", () => {
    expect(clientContractObs.clientSourceHasNoLoader).toBeTruthy();
  });

  it("客户端入口导出 apply", () => {
    expect(clientContractObs.clientSourceExportsApply).toBeTruthy();
  });

  it("客户端源码不得用 ctx.get() 取服务（服务经直接属性注入，#383）", () => {
    expect(clientContractObs.clientSourceHasNoCtxGet).toBeTruthy();
  });

  it.each([
    ["sessions", "ctx.sessions"],
    ["remote", "ctx.remote"],
    ["locale", "ctx.locale"],
    ["slots", "ctx.slots"],
  ])("客户端 apply 经直接属性 %s 访问 %s 服务", (prop, service) => {
    expect(clientContractObs.clientSource.includes(service)).toBeTruthy();
  });

  it("inject 数组必须声明 sessions（否则服务不可用，#383）", () => {
    expect(clientContractObs.injectLine.includes('"sessions"')).toBeTruthy();
  });

  it("inject 数组必须声明 remote（否则服务不可用，#383）", () => {
    expect(clientContractObs.injectLine.includes('"remote"')).toBeTruthy();
  });

  it("inject 数组必须声明 remote.session（modelCatalog 兜底，#383）", () => {
    expect(clientContractObs.injectLine.includes('"remote.session"')).toBeTruthy();
  });

  it("inject 数组必须声明 slots（否则 ctx.slots 访问抛 without inject，#383）", () => {
    expect(clientContractObs.injectLine.includes('"slots"')).toBeTruthy();
  });

  it("core.ts providerFromProjection 存在投影读取行", () => {
    expect(clientContractObs.projectionReadLine !== undefined).toBeTruthy();
  });

  it("投影读取必须 next 优先", () => {
    expect(/ms\?\.next \?\? ms\?\.lastUsed/.test(clientContractObs.projectionReadLine ?? ""), `当前行：${(clientContractObs.projectionReadLine ?? "").trim()}`).toBeTruthy();
  });

  it("客户端源码已去除 MCP 避让（mcpClearance）", () => {
    expect(clientContractObs.clientSourceHasNoMcpClearance).toBeTruthy();
  });

  it("客户端源码已去除 MCP 浮窗探测避让", () => {
    expect(clientContractObs.clientSourceHasNoMcpFloatProbe).toBeTruthy();
  });

  it("客户端源码用固定定位渲染胶囊", () => {
    expect(clientContractObs.clientSourceUsesFixed).toBeTruthy();
  });

  it("客户端已移除 SSE 长连接（EventSource）", () => {
    expect(clientContractObs.clientSourceHasNoEventSource).toBeTruthy();
  });

  it("客户端以 syncUiConfig 轮询代偿 ui-config 同步", () => {
    expect(clientContractObs.clientSourceHasSyncUiConfig).toBeTruthy();
  });

  it("pollReportTask 透传 status 响应的 reused 字段（轮询路径数据源）", () => {
    expect(clientContractObs.pollRetMatch !== null).toBeTruthy();
  });

  it("onGenerate 202 分支经 pollReportTask 拿 reused", () => {
    expect(clientContractObs.pollCallMatch !== null).toBeTruthy();
  });

  it("轮询路径 reused → 渲染「已复用」提示（与 200 直接复用路径对称）", () => {
    expect(clientContractObs.noticeMatch !== null).toBeTruthy();
  });

  it("200 直接复用路径「已复用」提示保留（对称基线）", () => {
    expect(clientContractObs.directMatch !== null).toBeTruthy();
  });

  it("renderPanel 内容更新完成后触发 applyUiPlacement 重定位（bottom 锚点防溢出）", () => {
    expect(clientContractObs.renderPanelRelocates).toBeTruthy();
  });

  it("toggleFloat 先 renderPanel 后 placePanel（以真实内容高度定位）", () => {
    expect(clientContractObs.toggleFloatOrderOk).toBeTruthy();
  });

  it.each(["isUsageStatsAdapter", "esc", "sanitizeHtml", "HistoryStore", "runV2Pipeline", "sseData"])("宿主产物应含 %s", (name) => {
    expect(clientContractObs.hostLib.includes(name)).toBeTruthy();
  });

  it.each(["trend", "report", "usage", "providers", "float"])("设置页 tab 键 %s 存在", (key) => {
    expect(clientContractObs.settingsIndex.includes(`"${key}"`)).toBeTruthy();
  });

  it("设置页窗格 keep-mounted（hidden 属性显隐，不卸载组件实例）（TSX 形态）", () => {
    expect(clientContractObs.settingsHasKeepMounted).toBeTruthy();
  });

  it("tab 状态不做 URL/存储持久化（与通知中心一致，避免宿主路由冲突）", () => {
    expect(clientContractObs.settingsHasNoUrlOrStorageState).toBeTruthy();
  });

  it("多 tab 结构类名进客户端产物", () => {
    expect(clientContractObs.bundleHasSetTabClasses).toBeTruthy();
  });

  it("分段器 role=group（#543 移动端适配）（TSX 形态）", () => {
    expect(clientContractObs.settingsHasRoleGroup).toBeTruthy();
  });

  it("分段器不得使用 role=navigation（#543）（TSX 形态）", () => {
    expect(clientContractObs.settingsHasNoRoleNavigation).toBeTruthy();
  });

  it("分段器 aria-label 走 i18n", () => {
    expect(clientContractObs.settingsNavLabelI18n).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #198 deepseek-official 内置适配器集成
//
// 覆盖：A1（失败 stale 帧 + capsuleHtml）/ A3（错误帧不落盘）/ A5（成功帧落盘）/
// E4（no-api-key → stale + 徽标常驻 G8）/ F1（builtin 默认启用）/ F2/K12（与 user-file
// 原型共存且注册顺序覆盖成立）/ F4（候选列表 source 区分）/ E5（密钥不出现在响应体）。
// 网络纪律：apiEndpoint 指向不可达回环（快速 network 失败），无任何出网请求。

describe("#198 deepseek-official 内置适配器集成 · 场景 1（纯 builtin）", () => {
  let builtinEnabled;
  let builtinCandidateHasBuiltinSource;
  let failPayloadOk;
  let failPayloadStatus;
  let failPayloadReason;
  let failPayloadCapsuleHtml;
  let failPayloadError;
  let builtinHistDirAbsent;
  let e5Bodies;

  beforeAll(async () => {
    const disposers = [];
    const { ctx, routes } = makeFakeCtx({
      effect(fn) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return typeof d === "function" ? d : () => {};
      },
    });
    await apply(ctx, { ...ISOLATED_CONFIG, provider: DEEPSEEK_OFFICIAL_PROVIDER, warmupIntervalMs: 0 });

    const historyRoot = join(process.env.DSH_HOME, "dsh-provider-usage");
    const withBody = (body) => fakeReq({ method: "POST", body });
    const getJSON = async (route, url) => callHandler(route, fakeReq({ url }));

    // F1：默认注册后 adapters.json 启用者 = builtin、source=builtin
    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    const meta = await getJSON(adaptersRoute, ROUTES.adapters);
    builtinEnabled = meta.enabled[DEEPSEEK_OFFICIAL_PROVIDER] === DEEPSEEK_OFFICIAL_ADAPTER_ID;
    const dsBuiltin = meta.host.find((a) => a.name === DEEPSEEK_OFFICIAL_ADAPTER_ID);
    builtinCandidateHasBuiltinSource = dsBuiltin !== undefined && dsBuiltin.source === "builtin";

    // 启动即预热会把失败帧写进缓存（warmupIntervalMs 有下限 clamp 无法关闭）；
    // select 语义自带 cache.clear()，重选 builtin 后下一次 stats 即全新取数。
    // 预热为 fire-and-forget，无需固定 sleep 等其完成——select 本身 await（callHandler）。
    const selectRoute1 = routes.find((r) => r.path === ROUTES.select);
    await callHandler(selectRoute1, withBody(JSON.stringify({ provider: DEEPSEEK_OFFICIAL_PROVIDER, adapterName: DEEPSEEK_OFFICIAL_ADAPTER_ID })));

    // A1：取数失败（不可达回环）→ HTTP 形状仍 200 由路由保证；ok=false / status=stale / capsuleHtml 非空
    const stats = routes.find((r) => r.path === ROUTES.stats);
    const failPayload = await getJSON(stats, `${ROUTES.stats}?provider=${DEEPSEEK_OFFICIAL_PROVIDER}`);
    failPayloadOk = failPayload.ok;
    // #120：select 自带清缓存 + 「清后立即预热」挂点——本请求命中的是预热刚写入的
    // 失败帧缓存（复用帧 status 标记为 cached；冷取直连则为 stale，两者皆合法），
    // 失败语义由 ok/reason/error 承载不受影响
    failPayloadStatus = failPayload.status;
    failPayloadReason = failPayload.reason;
    failPayloadCapsuleHtml = failPayload.capsuleHtml;
    failPayloadError = failPayload.error;

    // A3：错误帧绝不落盘历史——builtin 历史目录不应存在
    const builtinHistDir = join(historyRoot, DEEPSEEK_OFFICIAL_PROVIDER, DEEPSEEK_OFFICIAL_ADAPTER_ID);
    builtinHistDirAbsent = !existsSync(builtinHistDir);

    // E5：密钥不出现在任一响应体
    e5Bodies = { "adapters.json 响应": JSON.stringify(meta), "stats 响应": JSON.stringify(failPayload) };

    for (const d of [...disposers].reverse()) { try { d(); } catch { /* 忽略 */ } }
  });

  it("F1: deepseek-official 默认启用者为 deepseek-official-builtin", () => {
    expect(builtinEnabled).toBeTruthy();
  });

  it("F1: 候选含 builtin 条目且 source=builtin", () => {
    expect(builtinCandidateHasBuiltinSource).toBeTruthy();
  });

  it("A1: 失败帧 ok=false", () => {
    expect(failPayloadOk).toBe(false);
  });

  it("A1: 失败帧 status ∈ {stale, cached}", () => {
    expect(["stale", "cached"], `实际 ${failPayloadStatus}`).toContain(failPayloadStatus);
  });

  it("A1: 失败原因 fetch-failed", () => {
    expect(failPayloadReason).toBe("fetch-failed");
  });

  it("A1: 失败帧 capsuleHtml 非空", () => {
    expect(typeof failPayloadCapsuleHtml === "string" && failPayloadCapsuleHtml.length > 0).toBeTruthy();
  });

  it("A1: 空 data 渲染占位文案", () => {
    expect(failPayloadCapsuleHtml.includes("DeepSeek 余额 --")).toBeTruthy();
  });

  it("G8: stale 帧峰谷徽标常驻", () => {
    expect(failPayloadCapsuleHtml.includes("dou-peak")).toBeTruthy();
  });

  it("A1: 错误码 network", () => {
    expect(failPayloadError, `实际 ${failPayloadError}`).toBe("network");
  });

  it("A3: 取数失败后历史目录无 builtin 条目（错误帧未落盘）", () => {
    expect(builtinHistDirAbsent).toBeTruthy();
  });

  it.each(["adapters.json 响应", "stats 响应"])("E5: 响应体不含密钥子串（%s）", (label) => {
    expect(e5Bodies[label].includes("sk-smoke-test")).toBe(false);
  });
});

describe("#198 deepseek-official 内置适配器集成 · 场景 2（三级密钥全空 E4/G8）", () => {
  let payloadStatus;
  let payloadError;
  let payloadCapsuleHtml;
  let payloadHasNoSecretShape;

  beforeAll(async () => {
    const disposers = [];
    const { ctx, routes } = makeFakeCtx({
      effect(fn) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return typeof d === "function" ? d : () => {};
      },
    });
    await apply(ctx, { apiKey: "", apiEndpoint: "http://127.0.0.1:9", provider: DEEPSEEK_OFFICIAL_PROVIDER, warmupIntervalMs: 0 });
    // 预热为 fire-and-forget，select 自带 cache.clear() + 清后立即预热挂点，无需固定 sleep 等预热。
    const withBody = (body) => fakeReq({ method: "POST", body });
    const selectRoute2 = routes.find((r) => r.path === ROUTES.select);
    await callHandler(selectRoute2, withBody(JSON.stringify({ provider: DEEPSEEK_OFFICIAL_PROVIDER, adapterName: DEEPSEEK_OFFICIAL_ADAPTER_ID })));
    const stats = routes.find((r) => r.path === ROUTES.stats);
    const payload = await callHandler(stats, fakeReq({ url: `${ROUTES.stats}?provider=${DEEPSEEK_OFFICIAL_PROVIDER}` }));
    // #120：select 自带「清缓存 + 立即预热」挂点——本请求命中的是预热刚写入的
    // no-api-key 失败帧（复用帧 status=cached；冷取直连则为 stale，语义等价）
    payloadStatus = payload.status;
    payloadError = payload.error;
    payloadCapsuleHtml = payload.capsuleHtml;
    payloadHasNoSecretShape = !JSON.stringify(payload).includes("sk-");
    for (const d of [...disposers].reverse()) { try { d(); } catch { /* 忽略 */ } }
  });

  it("E4: 三级全空 → 失败帧", () => {
    expect(["stale", "cached"], `实际 ${payloadStatus}`).toContain(payloadStatus);
  });

  it("E4: 错误码 no-api-key", () => {
    expect(payloadError).toBe("no-api-key");
  });

  it("G8: no-api-key 下徽标仍渲染（纯本地时间计算）", () => {
    expect(payloadCapsuleHtml?.includes("dou-peak")).toBeTruthy();
  });

  it("E4: 响应不含任何密钥形态子串", () => {
    expect(payloadHasNoSecretShape).toBeTruthy();
  });
});

describe("#198 deepseek-official 内置适配器集成 · 场景 3（user-file 原型共存 K12/F2/F4/A5）", () => {
  let userFileAddOk;
  let userFileAddRaw;
  let userFileClaimsProvider;
  let sources;
  let metaHasNoSecret;
  let userAdapterTakenOver;
  let userAdapterStatus;
  let userCapsuleRendered;
  let statsHasNoSecret;
  let userHistDirExists;
  let historyAdapterName;
  let historyHasNoSecret;

  beforeAll(async () => {
    const disposers = [];
    const { ctx, routes } = makeFakeCtx({
      effect(fn) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return typeof d === "function" ? d : () => {};
      },
    });
    await apply(ctx, { ...ISOLATED_CONFIG, provider: DEEPSEEK_OFFICIAL_PROVIDER, warmupIntervalMs: 0 });

    // 用户 mjs 原型模拟：name 与 provider 同名（deepseek-official，原型形态），
    // 用于 K12 有意差异断言——与内置 -builtin 后缀名共存不冲突
    const userDir = mkdtempSync(join(tmpdir(), "dou-ds-user-"));
    const userFile = join(userDir, "deepseek-official.mjs");
    writeFileSync(userFile, `
export const version = 2;
export const name = "deepseek-official";
export const label = "DeepSeek 官方余额(用户)";
export const providers = ["${DEEPSEEK_OFFICIAL_PROVIDER}"];
export async function fetchData() { return { isAvailable: true, balance: 42.5, toppedUp: null, grantedBalance: null }; }
export function formatCapsule(i) { return "<span>USER ¥" + (typeof i.data.balance === "number" ? i.data.balance.toFixed(2) : "--") + "</span>"; }
export function formatPanel() { return "<p>user-panel</p>"; }
`, "utf8");

    const historyRoot = join(process.env.DSH_HOME, "dsh-provider-usage");
    const withBody = (body) => fakeReq({ method: "POST", body });
    const getJSON = async (route, url) => callHandler(route, fakeReq({ url }));

    const addRoute = routes.find((r) => r.path === ROUTES.add);
    const addPayload = await callHandler(addRoute, withBody(JSON.stringify({ file: userFile })));
    userFileAddOk = addPayload.ok;
    userFileAddRaw = JSON.stringify(addPayload).slice(0, 120);
    userFileClaimsProvider = addPayload.enabled[DEEPSEEK_OFFICIAL_PROVIDER] === "deepseek-official";

    // F4：设置页候选列表同时展示 builtin 与 user-file 且 source 区分
    const adaptersRoute = routes.find((r) => r.path === ROUTES.adapters);
    const meta = await getJSON(adaptersRoute, ROUTES.adapters);
    sources = Object.fromEntries(meta.host.filter((a) => a.providers.includes(DEEPSEEK_OFFICIAL_PROVIDER)).map((a) => [a.name, a.source]));
    metaHasNoSecret = !JSON.stringify(meta).includes("sk-smoke-test");

    // stats：用户版生效 → fresh + 用户胶囊文案（本地数据零网络）
    // #217：轮询替代固定 sleep——注册后 warmup 采样时序不定（CI 并行下更明显），
    // 反复查 stats 直到用户版接管（adapterName=deepseek-official），超时 3s 兜底。
    const stats = routes.find((r) => r.path === ROUTES.stats);
    let finalFresh = null;
    const pollDeadline = Date.now() + 3000;
    while (Date.now() < pollDeadline) {
      const snap = await getJSON(stats, `${ROUTES.stats}?provider=${DEEPSEEK_OFFICIAL_PROVIDER}`);
      if (snap.adapterName === "deepseek-official") { finalFresh = snap; break; }
      await new Promise((r) => setTimeout(r, 50));
    }
    userAdapterTakenOver = finalFresh;
    userAdapterStatus = finalFresh.status;
    userCapsuleRendered = finalFresh.capsuleHtml?.includes("USER ¥42.50");
    statsHasNoSecret = !JSON.stringify(finalFresh).includes("sk-smoke-test");

    // A5：成功帧正常落盘历史（对照 A3 的失败帧不落盘）——轮询等待落盘，不用固定 sleep
    const userHistDir = join(historyRoot, DEEPSEEK_OFFICIAL_PROVIDER, "deepseek-official");
    await pollUntil(() => {
      try { return readdirSync(userHistDir).some((f) => f.endsWith(".jsonl")); } catch { return false; }
    }, 4000, 50);
    userHistDirExists = existsSync(userHistDir);

    // history 路由对用户版可用（面板管线不崩）
    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const hist = await getJSON(historyRoute, `${ROUTES.history}?provider=${DEEPSEEK_OFFICIAL_PROVIDER}&days=1`);
    historyAdapterName = hist.adapterName;
    historyHasNoSecret = !JSON.stringify(hist).includes("sk-smoke-test");

    for (const d of [...disposers].reverse()) { try { d(); } catch { /* 忽略 */ } }
  });

  it("K12: user-file 原型注册成功", () => {
    expect(userFileAddOk, `实际 ${userFileAddRaw}`).toBe(true);
  });

  it("F2: 后注册的 user-file 认领同名 provider 时成为启用者", () => {
    expect(userFileClaimsProvider).toBeTruthy();
  });

  it("F4: builtin 条目 source=builtin", () => {
    expect(sources[DEEPSEEK_OFFICIAL_ADAPTER_ID]).toBe("builtin");
  });

  it("F4: user-file 条目 source=user-file", () => {
    expect(sources["deepseek-official"]).toBe("user-file");
  });

  it("E5: adapters.json 不含密钥", () => {
    expect(metaHasNoSecret).toBeTruthy();
  });

  it("K12: 用户原型适配器接管取数（轮询 3s 内应生效）", () => {
    expect(userAdapterTakenOver).toBeTruthy();
  });

  it("A5: 成功帧 fresh/cached", () => {
    expect(["fresh", "cached"], `实际 ${userAdapterStatus}`).toContain(userAdapterStatus);
  });

  it("A5: 用户版胶囊文案渲染", () => {
    expect(userCapsuleRendered).toBeTruthy();
  });

  it("E5: stats 响应不含密钥", () => {
    expect(statsHasNoSecret).toBeTruthy();
  });

  it("A5: fresh 帧已按 (provider, adapterName) 落盘历史目录", () => {
    expect(userHistDirExists).toBeTruthy();
  });

  it("history 路由对用户版可用（adapterName=deepseek-official）", () => {
    expect(historyAdapterName).toBe("deepseek-official");
  });

  it("E5: history 响应不含密钥", () => {
    expect(historyHasNoSecret).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #156/#120 warmup 多 provider 采样回归

/**
 * 回归：warmup 并发发起 + getStats 全局 mutex busy 短路 → 多 provider 只有
 * 注册序第一个能采样，其余零采样数小时（#156）。
 * #120 演进：per-provider 锁落地后 warmup 改为并行 void fire-and-forget——
 * 各 provider 持各自专用锁，并行发起互不 busy、互不阻塞；本用例保留
 * 「每个启用 provider 都被采样」的主断言（40ms IO 延迟维持真实持锁窗口）。
 */
describe("#156/#120 warmup 多 provider 采样回归", () => {
  let providerAAdapterName;
  let providerAStatus;
  let providerBAdapterName;
  let providerBStatus;

  beforeAll(async () => {
    // 构造两个用户适配器（providers 互不相同），注册表指向绝对路径 mjs
    const adapterDir = mkdtempSync(join(tmpdir(), "dou-warmup-adapters-"));
    const mkAdapter = (name, provider) => {
      const file = join(adapterDir, `${name}.mjs`);
      writeFileSync(file, `
export const version = 2;
export const name = "${name}";
export const label = "${name}";
export const providers = ["${provider}"];
export async function fetchData() {
  // 模拟真实远端 IO 延迟：让持锁窗口覆盖后续 provider 的同步检查段，
  // 否则 mock 同步完成过快、两请求都排进 mutex 队列，无法复现 busy 短路
  await new Promise((r) => setTimeout(r, 40));
  return { visits: 7 };
}
export function formatCapsule(input) { return "<span>" + input.data.visits + "</span>"; }
export function formatPanel() { return "<p>ok</p>"; }
`, "utf8");
      return file;
    };
    const fileA = mkAdapter("warm-a", "prov-a");
    const fileB = mkAdapter("warm-b", "prov-b");
    writeFileSync(userAdaptersFile(join(process.env.DSH_HOME, "dsh-provider-usage")), JSON.stringify({
      adapters: [
        { id: "warm-a", label: "Warm A", providers: ["prov-a"], file: fileA },
        { id: "warm-b", label: "Warm B", providers: ["prov-b"], file: fileB },
      ],
    }), "utf8");

    const disposers = [];
    const { ctx, routes } = makeFakeCtx({
      effect(fn) {
        const d = fn();
        if (typeof d === "function") disposers.push(d);
        return typeof d === "function" ? d : () => {};
      },
    });
    await apply(ctx, { ...ISOLATED_CONFIG, warmupIntervalMs: 60000 });
    // 启动即预热一次（并行 fire-and-forget）：两个 provider 取数采样完成的历史落盘
    // 即为就绪信号（fetchData 成功帧会 append 历史 jsonl），轮询等待而非固定 sleep。
    const histRoot = join(process.env.DSH_HOME, "dsh-provider-usage");
    const warmupLanded = (prov, name) => {
      try { return readdirSync(join(histRoot, prov, name)).some((f) => f.endsWith(".jsonl")); } catch { return false; }
    };
    await pollUntil(() => warmupLanded("prov-a", "warm-a") && warmupLanded("prov-b", "warm-b"), 4000, 50);

    const statsRoute = routes.find((r) => r.path === ROUTES.stats);
    const queryProvider = async (provider) => callHandler(statsRoute, fakeReq({ url: `${ROUTES.stats}?provider=${provider}` }));
    const pa = await queryProvider("prov-a");
    const pb = await queryProvider("prov-b");
    providerAAdapterName = pa.adapterName;
    providerAStatus = pa.status;
    providerBAdapterName = pb.adapterName;
    providerBStatus = pb.status;

    for (const d of [...disposers].reverse()) {
      try { d(); } catch { /* 忽略 */ }
    }
  });

  it("provider A 经 warmup 完成采样（适配器生效）", () => {
    expect(providerAAdapterName).toBe("warm-a");
  });

  it("provider A 非 stale 短路", () => {
    expect(providerAStatus, `实际 ${providerAStatus}`).not.toBe("stale");
  });

  it("provider B 经 warmup 完成采样——旧实现下 B 因全局 mutex busy 零采样（#156 主回归点；#120 后并行预热 + per-provider 锁保持该性质）", () => {
    expect(providerBAdapterName).toBe("warm-b");
  });

  it("provider B 非 stale 短路", () => {
    expect(providerBStatus, `实际 ${providerBStatus}`).not.toBe("stale");
  });
});

// ---------------------------------------------------------------- #105① /history 渲染缓存
//
// 子项①验收（issue #105 spec-writer 13 条清单，本节覆盖 AC#1–AC#11 行为断言；
// AC#12 性能三要素见 PR 正文实测数据、AC#13 见 README 宣称）。
//
// 机制：进程内 Map 缓存 runV2PanelPipeline 返回值字符串层 {panelHtml,error,at}，
// key=provider+adapterName+自然日粒度归一化 range；主失效=append 落盘全清
// （stats TTL 命中期间不产生新 append，主失效由 warmup×stats TTL 复合门控），
// select/add/热更新三挂点同清；TTL 90s 仅兜底；错误/无适配器响应不入缓存。

// ---- S0：纯函数定界与 key 正确性（AC#2 / AC#8 的常量与归一化部分）

describe("#105① S0：纯函数定界与 key 正确性", () => {
  let ttlIsInteger;
  let ttlInRange;
  let staleAtExactlyTtl;
  let staleAtTtlPlusOne;
  let freshWithinCustomTtl;
  let staleBeyondCustomTtl;
  let normalizedSameDay;
  let crossDayKeysDiffer;
  let sameDayDriftKeysEqual;
  let rangeWindowKeysDiffer;
  let providerInKey;
  let adapterNameInKey;

  beforeAll(() => {
    // AC#8：TTL 为 [60s,120s] 内编译期常量
    ttlIsInteger = Number.isInteger(PANEL_CACHE_TTL_MS);
    ttlInRange = PANEL_CACHE_TTL_MS >= 60000 && PANEL_CACHE_TTL_MS <= 120000;
    // 过期判定边界（严格大于）：at/now 分离入参支持注入时钟
    staleAtExactlyTtl = isPanelCacheStale({ at: 0 }, PANEL_CACHE_TTL_MS);
    staleAtTtlPlusOne = isPanelCacheStale({ at: 0 }, PANEL_CACHE_TTL_MS + 1);
    freshWithinCustomTtl = isPanelCacheStale({ at: 0 }, 59999, 60000);
    staleBeyondCustomTtl = isPanelCacheStale({ at: 0 }, 60001, 60000);

    // AC#2：自然日粒度归一化——同日内时钟漂移不进 key，跨日/不同 days 不同 key
    const t1 = new Date(2026, 1, 10, 9, 15, 12, 345).getTime();
    const t2 = new Date(2026, 1, 10, 20, 0, 0, 500).getTime();
    const dayOf = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
    normalizedSameDay = normalizeRangeDay({ start: t1, end: t2 });
    const expectedNormalized = { start: dayOf(t1), end: dayOf(t2) };
    normalizedSameDay = { actual: normalizeRangeDay({ start: t1, end: t2 }), expected: expectedNormalized };
    const nextDay = new Date(2026, 1, 11, 0, 0, 1).getTime();
    crossDayKeysDiffer = panelCacheKey("p", "a", { start: t1, end: t2 }) !== panelCacheKey("p", "a", { start: t1, end: nextDay });
    sameDayDriftKeysEqual = panelCacheKey("p", "a", { start: t1, end: t2 }) === panelCacheKey("p", "a", { start: t1 + 5000, end: t2 + 1500 });
    const weekMs = 7 * 86400000;
    rangeWindowKeysDiffer = panelCacheKey("p", "a", { start: t1 - weekMs, end: t1 }) !== panelCacheKey("p", "a", { start: t1 - 30 * 86400000, end: t1 });
    providerInKey = panelCacheKey("p1", "a", { start: t1, end: t2 }) !== panelCacheKey("p2", "a", { start: t1, end: t2 });
    adapterNameInKey = panelCacheKey("p", "a1", { start: t1, end: t2 }) !== panelCacheKey("p", "a2", { start: t1, end: t2 });
  });

  it("TTL 是编译期整数常量", () => {
    expect(ttlIsInteger).toBeTruthy();
  });

  it("TTL ∈ [60000,120000]", () => {
    expect(ttlInRange, `实际 ${PANEL_CACHE_TTL_MS}`).toBeTruthy();
  });

  it("恰好到龄未过期", () => {
    expect(staleAtExactlyTtl).toBe(false);
  });

  it("超龄 1ms 即过期", () => {
    expect(staleAtTtlPlusOne).toBe(true);
  });

  it("自定义 ttl 下界内新鲜", () => {
    expect(freshWithinCustomTtl).toBe(false);
  });

  it("自定义 ttl 超界过期", () => {
    expect(staleBeyondCustomTtl).toBe(true);
  });

  it("归一到当地当日零点", () => {
    expect(normalizedSameDay.actual).toEqual(normalizedSameDay.expected);
  });

  it("跨自然日 → 不同 key", () => {
    expect(crossDayKeysDiffer).toBeTruthy();
  });

  it("同自然日内秒级漂移不进 key（end=Date.now() 漂移不致缓存空转）", () => {
    expect(sameDayDriftKeysEqual).toBeTruthy();
  });

  it("days=7 与 days=30 归一化为不同 key", () => {
    expect(rangeWindowKeysDiffer).toBeTruthy();
  });

  it("provider 入 key", () => {
    expect(providerInKey).toBeTruthy();
  });

  it("adapterName 入 key", () => {
    expect(adapterNameInKey).toBeTruthy();
  });
});

// ---- S1：命中逐字节一致 + key 不含漂移时间戳 + append 落盘全清（AC#1/#2/#3 + 形状回归）

describe("#105① S1：命中逐字节一致 + key 不含漂移时间戳 + append 落盘全清", () => {
  let firstRequestCalls;
  let h1Ok;
  let h1RendersFirstVersion;
  let hitPathCalls;
  let h2PanelHtmlMatchesH1;
  let h2ErrorMatchesH1;
  let h2EndDrifted;
  let h2FieldShape;
  let days30Calls;
  let h30WindowIndependent;
  let days7Calls;
  let h7bReplaysH1;
  let freshSeen;
  let afterAppendCalls;
  let nBefore;
  let nAfter;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-105-cache-"));
    const spyFile = mkSpyFile(dir, "spy-a", "cache-spy-a", "cache-prov", countingPanel("__SPY_A"));
    const { ctx, routes, disposers } = makeCollectingCtx();
    await apply(ctx, {
      ...ISOLATED_CONFIG,
      provider: "cache-prov",
      adapter: spyFile,
      historyDir: join(dir, "hist"),
      cacheDurationMs: 5000, // stats 缓存 5s 到龄：让「重取→append→面板缓存全清」可在测试窗口触发
    });
    // 启动预热完成（getStats fresh → append#0 → 清空缓存）：以「jsonl 首行可读」为
    // 就绪信号（appendFile 内容已落盘）。禁用「文件存在」弱信号：append 在慢盘/
    // 线程池抖动下 open（建空文件）与 write（写内容）之间有可见窗口，弱信号在
    // 窗口内放行会让 h1 冷算读到空历史——CI run 34184469443 实证 `2 !== 1`
    // （nBefore=0、h3=2 = append#0+#1 双入账，计数断言错位红）。超时硬失败，
    // 预热链路病态时 fail-fast，不带病推进。
    await pollUntilJsonlReady(join(dir, "hist", "cache-prov", "cache-spy-a"));

    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const statsRoute = routes.find((r) => r.path === ROUTES.stats);

    // AC#1 冷算填缓存
    const h1 = await getHistory(historyRoute, "cache-prov", 7);
    firstRequestCalls = globalThis.__SPY_A;
    h1Ok = h1.ok;
    h1RendersFirstVersion = String(h1.panelHtml).includes('data-calls="1"');

    // AC#1+#2 时钟推进 ≥1s 后仍命中同一 key：panelHtml/error 逐字节一致、管道计数不增
    // （有意时间流逝断言，验证 key 不含时钟；轮询等时钟条件而非固定 sleep）
    const tClock = Date.now();
    await pollUntil(() => Date.now() - tClock >= 1000, 4000, 50);
    const h2 = await getHistory(historyRoute, "cache-prov", 7);
    hitPathCalls = globalThis.__SPY_A;
    h2PanelHtmlMatchesH1 = h2.panelHtml === h1.panelHtml;
    h2ErrorMatchesH1 = h2.error === h1.error;
    h2EndDrifted = h2.range.end > h1.range.end;
    h2FieldShape = Object.keys(h2).sort();

    // AC#2 不同 days 归一化为不同 key、互不串数据，range 回显各自真实 start/end
    const h30 = await getHistory(historyRoute, "cache-prov", 30);
    days30Calls = globalThis.__SPY_A;
    h30WindowIndependent = h30.range.end - h30.range.start > 29 * 86400000;
    const h7b = await getHistory(historyRoute, "cache-prov", 7);
    days7Calls = globalThis.__SPY_A;
    h7bReplaysH1 = h7b.panelHtml === h1.panelHtml;

    // AC#3 主失效：等 stats TTL(5s) 到龄 → 轮询 stats 直到返回 fresh（到龄重取 fresh →
    // append 落盘 → 面板缓存全清）；事件驱动，避免固定 sleep 5200。
    nBefore = Number(h1.panelHtml.match(/data-n="(\d+)"/)[1]);
    freshSeen = await pollUntil(async () => {
      const s = await callRoute(statsRoute, { url: `${ROUTES.stats}?provider=cache-prov` });
      return s?.status === "fresh" ? s : undefined;
    }, 8000, 200);
    const h3 = await getHistory(historyRoute, "cache-prov", 7);
    afterAppendCalls = globalThis.__SPY_A;
    nAfter = Number(h3.panelHtml.match(/data-n="(\d+)"/)[1]);

    disposeAll(disposers);
  });

  it("首次请求完整执行管道", () => {
    expect(firstRequestCalls).toBe(1);
  });

  it("首次 /history ok=true", () => {
    expect(h1Ok).toBe(true);
  });

  it("冷算渲染首版", () => {
    expect(h1RendersFirstVersion).toBeTruthy();
  });

  it("命中路径不重跑管道（query+formatPanel 计数均不增）", () => {
    expect(hitPathCalls).toBe(1);
  });

  it("二次响应 panelHtml 与首次逐字节一致", () => {
    expect(h2PanelHtmlMatchesH1).toBeTruthy();
  });

  it("error 字段一致", () => {
    expect(h2ErrorMatchesH1).toBeTruthy();
  });

  it("end 已随系统时钟漂移但不进 key，仍命中", () => {
    expect(h2EndDrifted).toBeTruthy();
  });

  it("八字段响应形状不变（AC#10 回归）", () => {
    expect(h2FieldShape).toEqual(["adapterName", "error", "ok", "panelHtml", "plugin", "provider", "range", "version"]);
  });

  it("days=30 新 key 冷算", () => {
    expect(days30Calls).toBe(2);
  });

  it("days=30 窗口独立", () => {
    expect(h30WindowIndependent).toBeTruthy();
  });

  it("days=7 条目未被 days=30 冲掉，仍命中", () => {
    expect(days7Calls).toBe(2);
  });

  it("days=7 回放原条目", () => {
    expect(h7bReplaysH1).toBeTruthy();
  });

  it("stats TTL 到龄后重取 fresh（append 落盘触发面板缓存全清）", () => {
    expect(freshSeen !== undefined).toBeTruthy();
  });

  it("append 落盘后缓存整体清除、完整管道重跑", () => {
    expect(afterAppendCalls).toBe(3);
  });

  it("重算结果反映新落盘 entry", () => {
    expect(nAfter).toBe(nBefore + 1);
  });
});

// ---- S2：select 切换/清空挂点失效（AC#4）

describe("#105① S2：select 切换/清空挂点失效（AC#4）", () => {
  let selAColdCalls;
  let addSelBOk;
  let selBIsEnabledAdapter;
  let selBCalls;
  let switchBackOk;
  let switchBackRecalculated;
  let switchBackReturnsNewHtml;
  let clearOk;
  let clearedReason;
  let clearedPanelHtml;
  let clearedAdapterName;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-105-select-"));
    const fileA = mkSpyFile(dir, "sel-a", "sel-spy-a", "sel-prov", countingPanel("__SPY_SEL_A"));
    const fileB = mkSpyFile(dir, "sel-b", "sel-spy-b", "sel-prov", countingPanel("__SPY_SEL_B"));
    const { ctx, routes, disposers } = makeCollectingCtx();
    await apply(ctx, {
      ...ISOLATED_CONFIG,
      provider: "sel-prov",
      adapter: fileA,
      historyDir: join(dir, "hist"),
    });
    await pollUntil(() => {
      try { return readdirSync(join(dir, "hist", "sel-prov", "sel-spy-a")).some((f) => f.endsWith(".jsonl")); } catch { return false; }
    }, 4000, 50);

    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const addRoute = routes.find((r) => r.path === ROUTES.add);
    const selectRoute = routes.find((r) => r.path === ROUTES.select);

    const ha1 = await getHistory(historyRoute, "sel-prov", 7);
    selAColdCalls = globalThis.__SPY_SEL_A;

    // 登记 sel-b（add 抢占成为启用者），按 sel-b 重算填其条目
    const added = await postJson(addRoute, { file: fileB });
    addSelBOk = added.ok;
    const hb1 = await getHistory(historyRoute, "sel-prov", 7);
    selBIsEnabledAdapter = hb1.adapterName === "sel-spy-b";
    selBCalls = globalThis.__SPY_SEL_B;

    // 切回 sel-a：select 挂点必须已清缓存——否则这里会复用切换前的旧 sel-a 条目
    const switched = await postJson(selectRoute, { provider: "sel-prov", adapterName: "sel-spy-a" });
    switchBackOk = switched.ok;
    const ha2 = await getHistory(historyRoute, "sel-prov", 7);
    switchBackRecalculated = globalThis.__SPY_SEL_A;
    switchBackReturnsNewHtml = String(ha2.panelHtml).includes('data-calls="2"');

    // 清空（adapterName=null）：结构化 reason，绝不回吐任何旧 HTML
    const cleared = await postJson(selectRoute, { provider: "sel-prov", adapterName: null });
    clearOk = cleared.ok;
    const hnone = await getHistory(historyRoute, "sel-prov", 7);
    clearedReason = hnone.reason;
    clearedPanelHtml = hnone.panelHtml;
    clearedAdapterName = hnone.adapterName;

    disposeAll(disposers);
  });

  it("sel-a 冷算填缓存", () => {
    expect(selAColdCalls).toBe(1);
  });

  it("add sel-b 成功", () => {
    expect(addSelBOk).toBe(true);
  });

  it("sel-b 已是启用者", () => {
    expect(selBIsEnabledAdapter).toBeTruthy();
  });

  it("sel-b 冷算计数为 1", () => {
    expect(selBCalls).toBe(1);
  });

  it("切换 select 成功", () => {
    expect(switchBackOk).toBe(true);
  });

  it("切换后旧缓存不得复用、按新启用关系重算", () => {
    expect(switchBackRecalculated).toBe(2);
  });

  it("返回的是重算新 HTML 而非旧快照", () => {
    expect(switchBackReturnsNewHtml).toBeTruthy();
  });

  it("清空 select 成功", () => {
    expect(clearOk).toBe(true);
  });

  it("清空后返回 no-enabled-adapter 结构化 JSON", () => {
    expect(clearedReason).toBe("no-enabled-adapter");
  });

  it("panelHtml=null 而非任何旧 HTML", () => {
    expect(clearedPanelHtml).toBe(null);
  });

  it("清空后 adapterName=null", () => {
    expect(clearedAdapterName).toBe(null);
  });
});

// ---- S3：错误与 no-adapter 响应不入缓存、条件消除立即恢复（AC#7）

describe("#105① S3：错误与 no-adapter 响应不入缓存、条件消除立即恢复（AC#7）", () => {
  let e1Ok;
  let e1ErrorNotNil;
  let errRecalculatedCalls;
  let e2Ok;
  let ghostReason;
  let ghostPanelHtml;
  let ghostReasonStable;
  let ghostAdapterName;
  let addOkSpyOk;
  let recoveredOk;
  let recoveredAdapterName;
  let okESpyCalls;
  let ghostAddOk;
  let ghostRecoveredOk;
  let ghostSpyCalls;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-105-err-"));
    const errFile = join(dir, "err-a.mjs");
    writeFileSync(errFile, `
export const version = 2;
export const name = "err-spy";
export const providers = ["err-prov"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>c</span>"; }
export function formatPanel(input) {
  globalThis.__SPY_ERR = (globalThis.__SPY_ERR ?? 0) + 1;
  throw new Error("format-boom");
}
`, "utf8");
    const okFile = mkSpyFile(dir, "ok-e", "ok-e-spy", "err-prov", countingPanel("__SPY_OK_E"));
    const ghostFile = mkSpyFile(dir, "ghost-ok", "ghost-ok-spy", "ghost-prov", countingPanel("__SPY_GHOST"));
    const { ctx, routes, disposers } = makeCollectingCtx();
    await apply(ctx, {
      ...ISOLATED_CONFIG,
      provider: "err-prov",
      adapter: errFile,
      historyDir: join(dir, "hist"),
    });
    await pollUntil(() => {
      try { return readdirSync(join(dir, "hist", "err-prov", "err-spy")).some((f) => f.endsWith(".jsonl")); } catch { return false; }
    }, 4000, 50);

    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const addRoute = routes.find((r) => r.path === ROUTES.add);

    const e1 = await getHistory(historyRoute, "err-prov", 7);
    e1Ok = e1.ok;
    e1ErrorNotNil = e1.error !== null && String(e1.error).length > 0;

    // 关键：两次错误请求之间【无任何 clear 挂点动作】——若错误入了缓存，
    // 第二次会在剩余 TTL 内复读旧错误（计数维持 1）；未入缓存则必然重算。
    // 有意时间流逝窗口：轮询等时钟推进 ≥1.1s，而非固定 sleep。
    const tErr = Date.now();
    await pollUntil(() => Date.now() - tErr >= 1100, 4000, 50);
    const e2 = await getHistory(historyRoute, "err-prov", 7);
    errRecalculatedCalls = globalThis.__SPY_ERR;
    e2Ok = e2.ok;

    // no-adapter：结构化响应不入缓存（连续两次一致、无崩溃）
    const g1 = await getHistory(historyRoute, "ghost-prov", 7);
    ghostReason = g1.reason;
    ghostPanelHtml = g1.panelHtml;
    const g2 = await getHistory(historyRoute, "ghost-prov", 7);
    ghostReasonStable = g2.reason;
    ghostAdapterName = g2.adapterName;

    // 条件消除：登记正常适配器顶替错误适配器 → 下一次请求立即成功
    const added = await postJson(addRoute, { file: okFile });
    addOkSpyOk = added.ok;
    const o1 = await getHistory(historyRoute, "err-prov", 7);
    recoveredOk = o1.ok;
    recoveredAdapterName = o1.adapterName;
    okESpyCalls = globalThis.__SPY_OK_E;

    // ghost-prov 条件消除（注册适配器）后同样立即可用
    const gAdded = await postJson(addRoute, { file: ghostFile });
    ghostAddOk = gAdded.ok;
    const g3 = await getHistory(historyRoute, "ghost-prov", 7);
    ghostRecoveredOk = g3.ok;
    ghostSpyCalls = globalThis.__SPY_GHOST;

    disposeAll(disposers);
  });

  it("formatPanel 抛错 → 错误响应", () => {
    expect(e1Ok).toBe(false);
  });

  it("error 非 undefined 语义经 null 化下发", () => {
    expect(e1ErrorNotNil).toBeTruthy();
  });

  it("错误响应不入缓存：第二次仍完整重算而非复读旧错误", () => {
    expect(errRecalculatedCalls).toBe(2);
  });

  it("第二次错误响应仍 ok=false", () => {
    expect(e2Ok).toBe(false);
  });

  it("ghost-prov reason=no-adapter", () => {
    expect(ghostReason).toBe("no-adapter");
  });

  it("no-adapter 响应 panelHtml=null", () => {
    expect(ghostPanelHtml).toBe(null);
  });

  it("no-adapter 结构化响应稳定重现", () => {
    expect(ghostReasonStable).toBe("no-adapter");
  });

  it("no-adapter 响应 adapterName=null", () => {
    expect(ghostAdapterName).toBe(null);
  });

  it("登记正常适配器成功", () => {
    expect(addOkSpyOk).toBe(true);
  });

  it("条件消除后立即重算并成功，不在剩余 TTL 内复读旧错误", () => {
    expect(recoveredOk).toBe(true);
  });

  it("条件消除后启用者为 ok-e-spy", () => {
    expect(recoveredAdapterName).toBe("ok-e-spy");
  });

  it("条件消除后 ok-e-spy 冷算计数为 1", () => {
    expect(okESpyCalls).toBe(1);
  });

  it("ghost-prov 登记适配器成功", () => {
    expect(ghostAddOk).toBe(true);
  });

  it("no-adapter 条件消除后立即出数据", () => {
    expect(ghostRecoveredOk).toBe(true);
  });

  it("ghost-prov 条件消除后 ghost-ok-spy 冷算计数为 1", () => {
    expect(ghostSpyCalls).toBe(1);
  });
});

// ---- S4：add 挂点失效（AC#5）——登记其他 provider 适配器，唯一变量即挂点全清

describe("#105① S4：add 挂点失效（AC#5）", () => {
  let addProviderColdCalls;
  let addOtherOk;
  let addPurgedCacheCalls;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-105-add-"));
    const mainFile = mkSpyFile(dir, "add-a", "add-spy-a", "add-prov", countingPanel("__SPY_ADD_A"));
    const otherFile = mkSpyFile(dir, "add-b", "add-spy-b", "other-add-prov", countingPanel("__SPY_ADD_B"));
    const { ctx, routes, disposers } = makeCollectingCtx();
    await apply(ctx, {
      ...ISOLATED_CONFIG,
      provider: "add-prov",
      adapter: mainFile,
      historyDir: join(dir, "hist"),
    });
    await pollUntil(() => {
      try { return readdirSync(join(dir, "hist", "add-prov", "add-spy-a")).some((f) => f.endsWith(".jsonl")); } catch { return false; }
    }, 4000, 50);

    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const addRoute = routes.find((r) => r.path === ROUTES.add);

    await getHistory(historyRoute, "add-prov", 7);
    addProviderColdCalls = globalThis.__SPY_ADD_A;

    // 登记一个【其他 provider】的适配器：add-prov 启用关系不变、key 不变、TTL 未到——
    // 唯一能让下一次请求重算的机制就是 add 成功后的缓存全清
    const added = await postJson(addRoute, { file: otherFile });
    addOtherOk = added.ok;
    await getHistory(historyRoute, "add-prov", 7);
    addPurgedCacheCalls = globalThis.__SPY_ADD_A;

    disposeAll(disposers);
  });

  it("add-prov 冷算计数为 1", () => {
    expect(addProviderColdCalls).toBe(1);
  });

  it("登记其他 provider 适配器成功", () => {
    expect(addOtherOk).toBe(true);
  });

  it("add 成功后旧缓存清除、下次 /history 重算", () => {
    expect(addPurgedCacheCalls).toBe(2);
  });
});

// ---- S5：热更新挂点失效（AC#6）——autoReload 下文件变更 → 新版代码渲染

describe("#105① S5：热更新挂点失效（AC#6）", () => {
  let beforeHotReloadRendersV1;
  let hotReloadTookEffect;
  let newFormatPanelExecuted;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-105-hr-"));
    const hrFile = mkSpyFile(
      dir, "hr-a", "hr-spy", "hr-prov",
      `globalThis.__SPY_HR = (globalThis.__SPY_HR ?? 0) + 1; return "<p data-v=\\"1\\">v1</p>";`,
      "// v1 marker line",
    );
    const { ctx, routes, disposers } = makeCollectingCtx();
    await apply(ctx, {
      ...ISOLATED_CONFIG,
      provider: "hr-prov",
      adapter: hrFile,
      autoReload: true,
      historyDir: join(dir, "hist"),
    });
    await pollUntil(() => {
      try { return readdirSync(join(dir, "hist", "hr-prov", "hr-spy")).some((f) => f.endsWith(".jsonl")); } catch { return false; }
    }, 4000, 50);

    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const w1 = await getHistory(historyRoute, "hr-prov", 7);
    beforeHotReloadRendersV1 = String(w1.panelHtml).includes('data-v="1"');

    // 改写文件 → 确定性驱动轮询一次 → onReload ok → 挂点 clear
    writeFileSync(hrFile, `
export const version = 2;
export const name = "hr-spy";
export const label = "hr-spy";
export const providers = ["hr-prov"];
export async function fetchData() { return { v: 2 }; }
export function formatCapsule() { return "<span>c</span>"; }
export function formatPanel(input) {
  globalThis.__SPY_HR = (globalThis.__SPY_HR ?? 0) + 1;
  return "<p data-v=\\"2\\">v2</p>";
}
// v2 marker line —— 内容长度与 v1 不同，保证 stamp 变化可检出
`, "utf8");

    await driveHotReloads(hrFile);
    const w2 = await getHistory(historyRoute, "hr-prov", 7);
    hotReloadTookEffect = String(w2.panelHtml).includes('data-v="2"');
    newFormatPanelExecuted = globalThis.__SPY_HR >= 2;

    disposeAll(disposers);
  });

  it("热更新前渲染 v1", () => {
    expect(beforeHotReloadRendersV1).toBeTruthy();
  });

  it("热更新成功回调后旧缓存清除（驱动一次轮询即以新版代码渲染）", () => {
    expect(hotReloadTookEffect).toBeTruthy();
  });

  it("新版 formatPanel 已被真实执行", () => {
    expect(newFormatPanelExecuted).toBeTruthy();
  });
});

// ---- S6：只缓存返回值字符串层——formatPanel 变异 entries 后命中不受影响（AC#9）

describe("#105① S6：只缓存返回值字符串层（AC#9）", () => {
  let firstComputeEntryLen;
  let mutationTookEffectInFirstCompute;
  let hitPathDoesNotReinvoke;
  let hitReplaysCachedString;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "dou-105-mut-"));
    const mutFile = join(dir, "mut-a.mjs");
    writeFileSync(mutFile, `
export const version = 2;
export const name = "mut-spy";
export const providers = ["mut-prov"];
export async function fetchData() { return { v: 1 }; }
export function formatCapsule() { return "<span>c</span>"; }
export function formatPanel(input) {
  globalThis.__SPY_MUT = (globalThis.__SPY_MUT ?? 0) + 1;
  const n = input.entries.length;
  input.entries.length = 0; // 变异入参：恶意/劣质用户代码探针
  return "<p data-len=\\"" + n + "\\" data-after=\\"" + input.entries.length + "\\">m</p>";
}
`, "utf8");
    const { ctx, routes, disposers } = makeCollectingCtx();
    await apply(ctx, {
      ...ISOLATED_CONFIG,
      provider: "mut-prov",
      adapter: mutFile,
      historyDir: join(dir, "hist"),
    });
    // 预热保证历史至少 1 条：以「jsonl 首行可读」为就绪信号（同 S1：文件存在
    // 弱信号会放进 open/write 间隙，lenN>=1 断言在 CI 慢盘下读空历史必红）
    await pollUntilJsonlReady(join(dir, "hist", "mut-prov", "mut-spy"));

    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const m1 = await getHistory(historyRoute, "mut-prov", 7);
    firstComputeEntryLen = Number(m1.panelHtml.match(/data-len="(\d+)"/)[1]);
    mutationTookEffectInFirstCompute = String(m1.panelHtml).includes('data-after="0"');

    const m2 = await getHistory(historyRoute, "mut-prov", 7);
    hitPathDoesNotReinvoke = globalThis.__SPY_MUT === 1;
    hitReplaysCachedString = m2.panelHtml === m1.panelHtml;

    disposeAll(disposers);
  });

  it("首算基于原始 entries", () => {
    expect(firstComputeEntryLen, `len=${firstComputeEntryLen}`).toBeGreaterThanOrEqual(1);
  });

  it("变异在首算内生效过", () => {
    expect(mutationTookEffectInFirstCompute).toBeTruthy();
  });

  it("命中路径不再调用 formatPanel", () => {
    expect(hitPathDoesNotReinvoke).toBeTruthy();
  });

  it("命中回放缓存字符串层——绝不读取/复用 entries 中间层重渲染", () => {
    expect(hitReplaysCachedString).toBeTruthy();
  });
});

// ---- S7：不引入条件请求协商——无 ETag/Last-Modified 头、协商头请求仍 200 全量体（AC#11）

describe("#105① S7：不引入条件请求协商（AC#11）", () => {
  let responseCode;
  let offendingConditionalHeader;
  let bodyHasFullShape;

  beforeAll(async () => {
    const { ctx, routes, disposers } = makeCollectingCtx();
    await apply(ctx, { ...ISOLATED_CONFIG, historyDir: join(mkdtempSync(join(tmpdir(), "dou-105-etag-")), "hist") });
    const historyRoute = routes.find((r) => r.path === ROUTES.history);

    let code = 0;
    let hdrs = {};
    let raw = "";
    // async handler 统一 await（等响应位）：writeJson 在 resolve 前同步触发 end 回调，
    // await 完成后 code/hdrs/raw 已就绪，无需固定 sleep。
    await callHandler(
      historyRoute,
      fakeReq({
        url: `${ROUTES.history}?days=7`,
        headers: {
          host: "127.0.0.1:3080",
          "sec-fetch-site": "same-origin",
          "if-none-match": '"W/fake-etag"',
          "if-modified-since": "Mon, 09 Feb 2026 00:00:00 GMT",
        },
      }),
      {
        writeHead: (c, h) => { code = c; hdrs = h ?? {}; },
        end: (chunk) => { raw = chunk; },
      },
    );

    responseCode = code;
    offendingConditionalHeader = Object.keys(hdrs).find((k) => {
      const lk = k.toLowerCase();
      return lk === "etag" || lk === "last-modified";
    });
    const p = JSON.parse(raw);
    bodyHasFullShape = "panelHtml" in p && "range" in p;

    disposeAll(disposers);
  });

  it("携带 If-None-Match/If-Modified-Since 一律完整 200，不做 304 短路", () => {
    expect(responseCode).toBe(200);
  });

  it("响应头不含协商头", () => {
    expect(offendingConditionalHeader, `发现 ${offendingConditionalHeader}`).toBeUndefined();
  });

  it("200 体为完整响应形状", () => {
    expect(bodyHasFullShape).toBeTruthy();
  });
});

// ---------------------------------------------------------------- #503 M1：trend 挂接（apply 集成）

describe("#503 M1：trend 挂接（apply 集成）", () => {
  let sessionEventListeners;
  let sessionFlushListeners;
  let sessionDisposedListeners;
  let unpersistedRows;
  let detailSliceLanded;
  let detailProvider;
  let detailInput;

  beforeAll(async () => {
    const { ctx, routes, listeners, emitEvent } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG });
    sessionEventListeners = (listeners.get("session/event") ?? []).length;
    sessionFlushListeners = (listeners.get("session/flush") ?? []).length;
    sessionDisposedListeners = (listeners.get("session/disposed") ?? []).length;

    // 合成事件流：header 归属折叠 + usage chunk 定稿
    const t = Date.now();
    const session = { id: "sess-trend" };
    emitEvent("session/event", session, { type: "request/header", seq: 1, time: t, data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } }, reason: "initial" } });
    emitEvent("session/event", session, { type: "assistant/message", seq: 2, time: t, data: { turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 50 } } });

    // /health 观测面
    const healthRes = [];
    routes.find((r) => r.path === ROUTES.health).handler(fakeReq(), { writeHead: () => {}, end: (c) => healthRes.push(JSON.parse(c)) });
    unpersistedRows = healthRes.at(-1).trend.unpersistedRows;

    // session/flush 官方排空点 → 明细分片落盘
    await listeners.get("session/flush")[0]();
    const trendRoot = join(process.env.DSH_HOME, "dsh-provider-usage", "trend");
    const day = dayKey(t);
    detailSliceLanded = existsSync(join(trendRoot, "details", `${day}.jsonl`));
    const rows = readFileSync(join(trendRoot, "details", `${day}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
    const detail = rows.find((r) => r.kind === "detail");
    detailProvider = detail.provider;
    detailInput = detail.input;
  });

  it("session/event 监听已注册", () => {
    expect(sessionEventListeners).toBe(1);
  });

  it("session/flush 官方排空点已注册", () => {
    expect(sessionFlushListeners).toBe(1);
  });

  it("session/disposed 监听已注册", () => {
    expect(sessionDisposedListeners).toBe(1);
  });

  it("/health trend 观测：未落盘行 = 1", () => {
    expect(unpersistedRows).toBe(1);
  });

  it("排空后当日语细分片落盘", () => {
    expect(detailSliceLanded).toBeTruthy();
  });

  it("落盘行归属（header 折叠）", () => {
    expect(detailProvider).toBe("deepseek");
  });

  it("落盘行 token", () => {
    expect(detailInput).toBe(100);
  });
});

describe("#503 M1：热重载不双算", () => {
  let hotReloadRowCount;
  let hotReloadInputs;

  beforeAll(async () => {
    // 热重载不双算：卸载后事件不计数；重新挂载独立记账
    const inst1 = makeFakeCtx();
    await apply(inst1.ctx, { ...ISOLATED_CONFIG });
    const t = Date.now();
    inst1.emitEvent("session/event", { id: "s-hot" }, { type: "assistant/message", seq: 1, time: t, data: { turn: 1, step: 1, usage: { inputTokens: 25, outputTokens: 25 } } });
    await inst1.effects.at(-1)(); // 卸载（async disposer：含 trend dispose await 刷盘）

    inst1.emitEvent("session/event", { id: "s-hot" }, { type: "assistant/message", seq: 2, time: t + 10, data: { turn: 1, step: 2, usage: { inputTokens: 100, outputTokens: 100 } } }); // 卸载后事件

    const inst2 = makeFakeCtx();
    await apply(inst2.ctx, { ...ISOLATED_CONFIG });
    inst2.emitEvent("session/event", { id: "s-hot" }, { type: "assistant/message", seq: 3, time: t + 20, data: { turn: 1, step: 3, usage: { inputTokens: 7, outputTokens: 7 } } });
    await inst2.effects.at(-1)(); // 卸载即排空

    const day = dayKey(t);
    const trendRoot = join(process.env.DSH_HOME, "dsh-provider-usage", "trend");
    const rows = readFileSync(join(trendRoot, "details", `${day}.jsonl`), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "detail" && r.session === "s-hot");
    hotReloadRowCount = rows.length;
    hotReloadInputs = rows.map((r) => r.input).sort((a, b) => a - b);
  });

  it("卸载前 1 次 + 重挂载后 1 次（卸载后事件与重放均不计）", () => {
    expect(hotReloadRowCount).toBe(2);
  });

  it("input 只含 25 与 7（100 被丢弃）", () => {
    expect(hotReloadInputs).toEqual([7, 25]);
  });
});

// ---------------------------------------------------------------- #503 M2：/trend 路由集成断言

describe("#503 M2：/trend 路由集成断言", () => {
  const obs: Record<string, any> = {};

  beforeAll(async () => {
    // 独立 historyDir：隔离磁盘分片（防前序块的落盘行经启动重建混进本块断言口径）
    const dir = mkdtempSync(join(tmpdir(), "dou-trend-api-"));
    const { ctx, routes, listeners, emitEvent } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG, historyDir: join(dir, "hist") });
    const trendRoute = routes.find((r) => r.path === ROUTES.trend);
    obs.trendRouteExists = trendRoute !== undefined;

    // 合成事件流：两个会话各一次定稿调用（header 归属折叠 + usage chunk 定稿）
    const t = Date.now();
    const emitCall = (sessionId, seqBase, provider, model, input, output) => {
      const s = { id: sessionId };
      emitEvent("session/event", s, { type: "request/header", seq: seqBase, time: t, data: { header: { config: { provider, model } }, reason: "initial" } });
      emitEvent("session/event", s, { type: "assistant/message", seq: seqBase + 1, time: t, data: { turn: 1, step: 1, usage: { inputTokens: input, outputTokens: output } } });
    };
    emitCall("sess-trend-api-a", 1, "deepseek", "deepseek-chat", 100, 50);
    emitCall("sess-trend-api-b", 1, "openai", "gpt-x", 10, 5);

    // 官方排空点先行刷盘（路由读内存聚合，此处主要验证 flush 与查询共存不崩）
    await listeners.get("session/flush")[0]();

    const today = dayKey(t);
    obs.today = today;

    // 默认参数（granularity=day / metric=total）：200 形状
    const payload = await callHandler(trendRoute, fakeReq({ url: ROUTES.trend }));
    obs.payloadOk = payload.ok;
    obs.payloadPlugin = payload.plugin;
    obs.payloadVersion = payload.version;
    obs.payloadGranularity = payload.granularity;
    obs.payloadMetric = payload.metric;
    obs.payloadByModel = payload.byModel;
    obs.payloadSeriesIs30 = Array.isArray(payload.series) && payload.series.length === 30;
    obs.payloadProvidersIs2 = Array.isArray(payload.providers) && payload.providers.length === 2;
    obs.payloadGeneratedAtIsNumber = typeof payload.generatedAt === "number";
    obs.baselineSeries = payload.series;

    // 今日桶：total = 100+50+10+5 = 165（>0）；段拆到 provider
    const todayPoint = payload.series.find((p) => p.key === today);
    obs.todayPointExists = todayPoint !== undefined;
    obs.todayTotal = todayPoint.total;
    const deepseekPart = todayPoint.parts.find((p) => p.provider === "deepseek");
    obs.todayDeepseekPartIs150 = deepseekPart && deepseekPart.value === 150;
    // 空桶补齐为 null（30 桶内仅今日有数据——独立 historyDir 保证）
    obs.emptyBucketCount = payload.series.filter((p) => p.total === null).length;

    // 窗口摘要
    obs.summaryCalls = payload.summary.calls;
    obs.summaryTotal = payload.summary.total;
    obs.summaryPeakKey = payload.summary.peakKey;
    obs.summaryTopIsDeepseek150 = payload.summary.top && payload.summary.top.provider === "deepseek" && payload.summary.top.value === 150;
    obs.summaryPrevTotal = payload.summary.prevTotal;

    // 起算日（「统计自挂载时点起算」数据源）
    obs.firstDay = payload.firstDay;

    // ?metric=calls 指标切换：取值维度切到调用次数
    const callsPayload = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?metric=calls` }));
    obs.callsMetric = callsPayload.metric;
    obs.callsTodayTotal = callsPayload.series.find((p) => p.key === today).total;
    obs.callsSummaryTotal = callsPayload.summary.total;

    // ?granularity=week：周粒度 12 桶，本周聚合两天数据（实际仅今日）
    const weekPayload = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?granularity=week` }));
    obs.weekGranularity = weekPayload.granularity;
    obs.weekSeriesLength = weekPayload.series.length;
    obs.weekCurrentTotal = weekPayload.series.at(-1).total;

    // ?provider=deepseek 过滤：只剩该 provider 的段与图例
    const filtered = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?provider=deepseek` }));
    obs.filteredTodayTotal = filtered.series.find((p) => p.key === today).total;
    obs.filteredProvidersLength = filtered.providers.length;

    // ?byModel=1：段拆到 provider+model，图例并集细到 model
    const byModelPayload = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?byModel=1` }));
    obs.byModelEcho = byModelPayload.byModel;
    const byModelToday = byModelPayload.series.find((p) => p.key === today);
    obs.byModelPartsLength = byModelToday.parts.length;
    obs.byModelPartKeys = byModelToday.parts.map((p) => `${p.provider}/${p.model}`).sort();

    // 非法参数回退默认（守卫：未知 granularity/metric 不进查询面）
    const fallback = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?granularity=hour&metric=evil` }));
    obs.fallbackGranularity = fallback.granularity;
    obs.fallbackMetric = fallback.metric;

    // ---------------------------------------------------------------- #633 分片 b B1：/trend 目录过滤参数（传/不传对比 + 非法回退）
    // 本块会话无 resolveCwd 接入（fake ctx 未提供 sessions store）→ 目录恒归
    // 未识别桶——两会话用量同入 (unidentified) 桶，正可断言过滤生效与图例形态。
    {
      // 未传 dir：现状形状零变化（providers 图例、无 dirs 数据段、dir=null 回显）
      const noDir = await callHandler(trendRoute, fakeReq({ url: ROUTES.trend }));
      obs.noDirDir = noDir.dir;
      obs.noDirShape = noDir.providers.length === 2 && noDir.dirs.length === 0;
      obs.noDirSeries = noDir.series;
      // 传 dir=未识别桶键：过滤面生效（本块两会话均为未识别目录）
      const UNK = "(unidentified)";
      obs.UNK = UNK;
      const withDir = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?dir=${encodeURIComponent(UNK)}` }));
      obs.withDirDir = withDir.dir;
      obs.withDirTodayTotal = withDir.series.find((p) => p.key === today).total;
      obs.withDirLegendHasUnk = withDir.dirs.some((d) => d.dir === UNK);
      obs.withDirProvidersLength = withDir.providers.length;
      // 传不存在的目录：过滤面空集（不回退全目录、不报错）
      const ghost = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?dir=ghost-dir` }));
      obs.ghostTodayTotal = ghost.series.find((p) => p.key === today).total;
      obs.ghostDirsLength = ghost.dirs.length;
      // 非法 dir（超长 257 字符，超数据层 TREND_DIR_MAX=256）→ 回退全目录（与未传同形状，不 400）
      // #633 修复：原用例写 129 字符——它把「路由硬编码 128、与数据层 256 不一致」的
      // 错误行为锁死（129–256 的合法目录键被静默降级为全目录聚合）。上限改由
      // TREND_DIR_MAX 单源导出，此处按数据层真上限 +1 构造超长值。
      const longDir = "x".repeat(TREND_DIR_MAX + 1);
      const badDir = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?dir=${encodeURIComponent(longDir)}` }));
      obs.badDirSeries = badDir.series;
      obs.badDirDir = badDir.dir;
      // 边界内侧：恰为上限的目录键是合法过滤值（不再被静默降级——原 128 口径的回归防线）
      const maxLenDir = "y".repeat(TREND_DIR_MAX);
      obs.maxLenDir = maxLenDir;
      const maxDir = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?dir=${encodeURIComponent(maxLenDir)}` }));
      obs.maxDirDir = maxDir.dir;
      obs.maxDirByDir = maxDir.byDir;
      obs.maxDirTodayTotal = maxDir.series.find((p) => p.key === today).total;
      // #633 P2：dir+byDir 同传 → 回显实际生效面（dir 过滤面生效，byDir 回显 false）
      const bothParams = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?dir=${encodeURIComponent(UNK)}&byDir=1` }));
      obs.bothParamsDir = bothParams.dir;
      obs.bothParamsByDir = bothParams.byDir;

      // ---------------------------------------------------------------- #633 分片 b2 D2/B1：byDir=1 全目录拆段面（加性，不影响 b1 断言）
      {
        const byDirAll = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?byDir=1` }));
        obs.byDirAllByDir = byDirAll.byDir;
        obs.byDirAllDir = byDirAll.dir;
        obs.byDirAllTodayTotal = byDirAll.series.find((p) => p.key === today).total;
        const unkPart = byDirAll.series.find((p) => p.key === today).parts.find((p) => p.provider === UNK);
        obs.byDirUnkPartIs165 = unkPart && unkPart.value === 165;
        obs.byDirLegendHasUnk = byDirAll.dirs.some((d) => d.dir === UNK);
        // #633 复核 P1-5：byDir 默认面加性附 providers 候选——适配器下拉数据链路可达
        obs.byDirProviderCandidates = byDirAll.providers.map((p) => p.provider).sort();
        // 适配器选择 → provider 面往返链路：候选项值可直接驱动 provider 过滤查询
        const picked = byDirAll.providers.map((p) => p.provider).sort()[0];
        const roundTrip = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?provider=${encodeURIComponent(picked)}` }));
        obs.roundTripProvidersLength = roundTrip.providers.length;
        obs.roundTripSeriesNonEmpty = roundTrip.series.some((p) => p.total !== null);
        // 不带 byDir 的现状面与 byDir 面共存：b1「未传 dir 序列 = 基线」断言已锁定零回归
      }
    }

    // ---------------------------------------------------------------- #503 M2.1：n 参数 + 按粒度×留存 clamp + 新响应字段

    // 新响应字段：n（clamp 后实际桶数）、retentionDays（客户端裁档位依据）、summary.prevComplete
    obs.payloadN = payload.n;
    obs.payloadRetentionDays = payload.retentionDays;
    obs.payloadPrevComplete = payload.summary.prevComplete;

    // ?n=7：日序列 7 桶；?n=90：≤retention 上限内放行
    const n7 = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?n=7` }));
    obs.n7N = n7.n;
    obs.n7SeriesLength = n7.series.length;
    const n90 = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?n=90` }));
    obs.n90SeriesLength = n90.series.length;
    const nOver = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?n=9999` }));
    obs.nOverN = nOver.n;
    obs.nOverSeriesLength = nOver.series.length;

    // 周粒度 clamp：cap = ⌈180/7⌉ = 26（周桶按周一对齐，26 桶跨度可能触留存边缘——属预期）
    const w26 = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?granularity=week&n=26` }));
    obs.w26SeriesLength = w26.series.length;
    const wOver = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?granularity=week&n=99` }));
    obs.wOverN = wOver.n;

    // 月粒度 clamp：cap = ⌈180/30⌉ = 6（月 12 档跨度 365 天 > 180 天留存——r1 方案口径错误已修正）
    const m6 = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?granularity=month&n=6` }));
    obs.m6SeriesLength = m6.series.length;
    const mOver = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?granularity=month&n=12` }));
    obs.mOverN = mOver.n;

    // 非法 n 回退默认（0/负数/非整数/非数字/空串）
    obs.badNResults = {};
    for (const bad of ["0", "-5", "3.7", "abc", ""]) {
      const badPayload = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?granularity=week&n=${encodeURIComponent(bad)}` }));
      obs.badNResults[bad] = badPayload.n;
    }
  });

  it("trend 路由存在", () => {
    expect(obs.trendRouteExists).toBeTruthy();
  });

  it("trend 默认 ok", () => {
    expect(obs.payloadOk).toBe(true);
  });

  it("trend plugin 字段", () => {
    expect(obs.payloadPlugin).toBe("dsh-provider-usage");
  });

  it("trend 带契约版本", () => {
    expect(obs.payloadVersion).toBe(ADAPTER_CONTRACT_VERSION);
  });

  it("granularity 默认 day", () => {
    expect(obs.payloadGranularity).toBe("day");
  });

  it("metric 默认 total", () => {
    expect(obs.payloadMetric).toBe("total");
  });

  it("byModel 默认 false", () => {
    expect(obs.payloadByModel).toBe(false);
  });

  it("日序列固定 30 桶", () => {
    expect(obs.payloadSeriesIs30).toBeTruthy();
  });

  it("图例并集 = 两个 provider", () => {
    expect(obs.payloadProvidersIs2).toBeTruthy();
  });

  it("generatedAt 时间戳", () => {
    expect(obs.payloadGeneratedAtIsNumber).toBeTruthy();
  });

  it("序列含今日桶", () => {
    expect(obs.todayPointExists).toBeTruthy();
  });

  it("今日 total = 165", () => {
    expect(obs.todayTotal, `实际 ${obs.todayTotal}`).toBe(165);
  });

  it("今日 deepseek 段 = 150", () => {
    expect(obs.todayDeepseekPartIs150).toBeTruthy();
  });

  it("无数据日 total=null", () => {
    expect(obs.emptyBucketCount).toBe(29);
  });

  it("summary.calls = 2 次调用", () => {
    expect(obs.summaryCalls).toBe(2);
  });

  it("summary.total = 165", () => {
    expect(obs.summaryTotal).toBe(165);
  });

  it("峰值桶 = 今日", () => {
    expect(obs.summaryPeakKey).toBe(obs.today);
  });

  it("top 段 = deepseek/150", () => {
    expect(obs.summaryTopIsDeepseek150).toBeTruthy();
  });

  it("上一窗口无数据 → prevTotal=null", () => {
    expect(obs.summaryPrevTotal).toBe(null);
  });

  it("firstDay = 最早有数据的当日", () => {
    expect(obs.firstDay).toBe(obs.today);
  });

  it("metric=calls 回显", () => {
    expect(obs.callsMetric).toBe("calls");
  });

  it("calls 指标下今日桶 = 2 次调用", () => {
    expect(obs.callsTodayTotal).toBe(2);
  });

  it("calls 指标下 summary.total = 2", () => {
    expect(obs.callsSummaryTotal).toBe(2);
  });

  it("granularity=week 回显", () => {
    expect(obs.weekGranularity).toBe("week");
  });

  it("周序列固定 12 桶", () => {
    expect(obs.weekSeriesLength).toBe(12);
  });

  it("当前周 total = 165", () => {
    expect(obs.weekCurrentTotal).toBe(165);
  });

  it("provider 过滤后今日 total = 150", () => {
    expect(obs.filteredTodayTotal).toBe(150);
  });

  it("过滤后图例只剩 deepseek", () => {
    expect(obs.filteredProvidersLength).toBe(1);
  });

  it("byModel=1 回显", () => {
    expect(obs.byModelEcho).toBe(true);
  });

  it("byModel 拆两段", () => {
    expect(obs.byModelPartsLength).toBe(2);
  });

  it("byModel 段含 model 维度", () => {
    expect(obs.byModelPartKeys).toEqual(["deepseek/deepseek-chat", "openai/gpt-x"]);
  });

  it("非法 granularity 回退 day", () => {
    expect(obs.fallbackGranularity).toBe("day");
  });

  it("非法 metric 回退 total", () => {
    expect(obs.fallbackMetric).toBe("total");
  });

  // ---- #633 分片 b B1 ----

  it("未传 dir → 回显 null（全目录聚合，现状形状）", () => {
    expect(obs.noDirDir).toBe(null);
  });

  it("未传 dir：providers 图例照旧、dirs 空数组（未过滤分支无目录段）", () => {
    expect(obs.noDirShape).toBeTruthy();
  });

  it("未传 dir：序列与基线请求逐桶一致（行为与 #633 前完全一致）", () => {
    expect(obs.noDirSeries).toEqual(obs.baselineSeries);
  });

  it("传 dir → 回显过滤键", () => {
    expect(obs.withDirDir).toBe(obs.UNK);
  });

  it("dir 过滤后今日 total = 该目录子集（本块全部数据在未识别桶）", () => {
    expect(obs.withDirTodayTotal).toBe(165);
  });

  it("dirs 图例含未识别桶（不消失）", () => {
    expect(obs.withDirLegendHasUnk).toBeTruthy();
  });

  it("dir 分支响应 providers 图例为空（目录维度拆段）", () => {
    expect(obs.withDirProvidersLength).toBe(0);
  });

  it("不存在目录 → 过滤面空集（null 语义）", () => {
    expect(obs.ghostTodayTotal).toBe(null);
  });

  it("不存在目录 → dirs 图例为空", () => {
    expect(obs.ghostDirsLength).toBe(0);
  });

  it("非法 dir（超长）回退全目录聚合（行为与未传一致）", () => {
    expect(obs.badDirSeries).toEqual(obs.baselineSeries);
  });

  it("非法 dir 回显 null", () => {
    expect(obs.badDirDir).toBe(null);
  });

  it(`上限（${TREND_DIR_MAX}）内的目录键按过滤面生效（回显键，不降级为全目录）`, () => {
    expect(obs.maxDirDir).toBe(obs.maxLenDir);
  });

  it("上限内的目录键 → byDir 回显 false（过滤面优先）", () => {
    expect(obs.maxDirByDir).toBe(false);
  });

  it("不存在的上限长目录 → 过滤面空集（而非全目录 165）", () => {
    expect(obs.maxDirTodayTotal).toBe(null);
  });

  it("dir+byDir 同传：dir 过滤面生效（回显 dir 键）", () => {
    expect(obs.bothParamsDir).toBe(obs.UNK);
  });

  it("dir+byDir 同传：byDir 回显 false（实际生效面，防虚假 true 误导客户端恢复逻辑）", () => {
    expect(obs.bothParamsByDir).toBe(false);
  });

  // ---- #633 分片 b2 D2/B1：byDir=1 全目录拆段面 ----

  it("byDir=1 回显 byDir=true", () => {
    expect(obs.byDirAllByDir).toBe(true);
  });

  it("byDir 面未过滤 → dir 回显 null", () => {
    expect(obs.byDirAllDir).toBe(null);
  });

  it("byDir 面今日 total = 全目录聚合 165（过滤面同口径）", () => {
    expect(obs.byDirAllTodayTotal).toBe(165);
  });

  it("byDir 面按目录拆段：未识别桶段 = 165（本块两会话均无 cwd）", () => {
    expect(obs.byDirUnkPartIs165).toBeTruthy();
  });

  it("byDir 面 dirs 图例含未识别桶（B2 不消失）", () => {
    expect(obs.byDirLegendHasUnk).toBeTruthy();
  });

  it("byDir 面 providers 候选 = 窗口内 distinct（修复前恒空，下拉不可达）", () => {
    expect(obs.byDirProviderCandidates).toEqual(["deepseek", "openai"]);
  });

  it("byDir 面候选 → provider 面往返：过滤查询生效", () => {
    expect(obs.roundTripProvidersLength).toBe(1);
  });

  it("往返面序列非空（候选值与 provider 面数据自洽）", () => {
    expect(obs.roundTripSeriesNonEmpty).toBeTruthy();
  });

  // ---- #503 M2.1：n 参数 ----

  it("响应带 n（默认 30）", () => {
    expect(obs.payloadN).toBe(30);
  });

  it("响应带 retentionDays（默认配置）", () => {
    expect(obs.payloadRetentionDays).toBe(180);
  });

  it("prev 窗口起点早于数据起点（仅今日）→ prevComplete=false", () => {
    expect(obs.payloadPrevComplete).toBe(false);
  });

  it("n=7 回显", () => {
    expect(obs.n7N).toBe(7);
  });

  it("n=7 日序列 7 桶", () => {
    expect(obs.n7SeriesLength).toBe(7);
  });

  it("n=90 日序列 90 桶（≤留存上限）", () => {
    expect(obs.n90SeriesLength).toBe(90);
  });

  it("n=9999 clamp 到留存上限 180（day ≤ retentionDays）", () => {
    expect(obs.nOverN).toBe(180);
  });

  it("clamp 后序列长度 == n", () => {
    expect(obs.nOverSeriesLength).toBe(180);
  });

  it("周 26 桶放行（⌈180/7⌉）", () => {
    expect(obs.w26SeriesLength).toBe(26);
  });

  it("周 n=99 clamp 到 26", () => {
    expect(obs.wOverN).toBe(26);
  });

  it("月 6 桶放行", () => {
    expect(obs.m6SeriesLength).toBe(6);
  });

  it("月 n=12 clamp 到 ⌈180/30⌉=6", () => {
    expect(obs.mOverN).toBe(6);
  });

  it.each(["0", "-5", "3.7", "abc", ""])("非法 n=%s 回退周默认 12", (bad) => {
    expect(obs.badNResults[bad]).toBe(12);
  });
});

// ---------------------------------------------------------------- #503 M3：用量报告接线（调度/落盘/路由/净化/不入统计）

describe("#503 M3：用量报告接线", () => {
  const obs: Record<string, any> = {};

  beforeAll(async () => {
    // 独立 historyDir：报告产物与趋势分片全部隔离在临时目录（零污染纪律）
    const dir = mkdtempSync(join(tmpdir(), "dou-report-"));
    const histDir = join(dir, "hist");
    const reportsDir = join(histDir, "reports");
    const { ctx, routes, listeners, emitEvent, effects } = makeFakeCtx();
    await apply(ctx, { ...ISOLATED_CONFIG, historyDir: histDir });
    const cfgRoute = routes.find((r) => r.path === ROUTES.reportConfig);
    const listRoute = routes.find((r) => r.path === ROUTES.reports);
    const detailRoute = routes.find((r) => r.path === ROUTES.reportDetail);
    const genRoute = routes.find((r) => r.path === ROUTES.reportGenerate);
    const trendRoute = routes.find((r) => r.path === ROUTES.trend);
    obs.reportRoutesExist = cfgRoute !== undefined && listRoute !== undefined && detailRoute !== undefined && genRoute !== undefined;

    // b. 默认挂载（报告全关）：无 reports/ 产物；GET /report-config 返回默认配置
    obs.noReportsDirOnDefaultMount = !existsSync(reportsDir);
    const defaultCfg = await callHandler(cfgRoute, fakeReq({ url: ROUTES.reportConfig }));
    obs.defaultCfgOk = defaultCfg.ok;
    obs.defaultDailyEnabled = defaultCfg.config.daily.enabled;
    obs.defaultWeeklyEnabled = defaultCfg.config.weekly.enabled;
    obs.defaultMonthlyEnabled = defaultCfg.config.monthly.enabled;
    obs.defaultPromptTemplateHasStats = defaultCfg.config.promptTemplate.includes("{stats}");
    obs.defaultProvidersFromLlm = Array.isArray(defaultCfg.providers) && defaultCfg.providers.length >= 2;

    // c. POST /report-config 保存（启用日报 22:00）→ GET 回读一致
    const savedCfg = await callHandler(
      cfgRoute,
      fakeReq({ method: "POST", body: JSON.stringify({ daily: { enabled: true, time: "22:00" }, push: { enabled: false } }) }),
    );
    obs.savedCfgOk = savedCfg.ok;
    obs.savedDailyEnabled = savedCfg.config.daily.enabled;
    obs.savedDailyTime = savedCfg.config.daily.time;
    const reread = await callHandler(cfgRoute, fakeReq({ url: ROUTES.reportConfig }));
    obs.rereadConfig = reread.config;
    obs.savedConfigSnapshot = savedCfg.config;

    // e0. #532 报告模型候选路由：已知 provider → listModels 白名单映射；未知/缺失 → unknown-provider
    {
      const modelsRoute = routes.find((r) => r.path === ROUTES.reportModels);
      obs.modelsRouteExists = modelsRoute !== undefined;
      const modelsOk = await callHandler(modelsRoute, fakeReq({ url: `${ROUTES.reportModels}?provider=anthropic` }));
      obs.modelsOkOk = modelsOk.ok;
      obs.modelsWhitelist = modelsOk.models;
      const modelsUnknown = await callHandler(modelsRoute, fakeReq({ url: `${ROUTES.reportModels}?provider=no-such` }));
      obs.modelsUnknown = modelsUnknown;
      const modelsMissing = await callHandler(modelsRoute, fakeReq({ url: ROUTES.reportModels }));
      obs.modelsMissing = modelsMissing;
    }

    // f. 前置：合成一点趋势数据（生成「不入统计」断言的对照快照）
    // 事件时间必须落在手动生成的闭环窗口内（昨日全天；空窗口会走 noData 短路不再调模型）
    const dueDaily = previousClosedWindow("daily", savedCfg.config, Date.now());
    const [wy, wm, wd] = dueDaily.endDay.split("-").map(Number);
    const t = new Date(wy, wm - 1, wd, 12, 0, 0).getTime();
    const sess = { id: "sess-report" };
    emitEvent("session/event", sess, { type: "request/header", seq: 1, time: t, data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } }, reason: "initial" } });
    emitEvent("session/event", sess, { type: "assistant/message", seq: 2, time: t, data: { turn: 1, step: 1, usage: { inputTokens: 80, outputTokens: 40 } } });
    await listeners.get("session/flush")[0](); // 官方排空点先行刷盘
    const trendBefore = await callHandler(trendRoute, fakeReq({ url: ROUTES.trend }));

    // #625 辅助：提交生成 → 轮询 status 到 done（fake 队列立即执行；防 flake 轮询替代固定 sleep）
    const statusRoute = routes.find((r) => r.path === ROUTES.reportGenerateStatus);
    obs.statusRouteExists = statusRoute !== undefined;
    /** 每次 generateAndAwait 调用的观测（原 helper 内 5 条断言各自逐次记录） */
    const genObs = [];
    const generateAndAwait = async (body) => {
      const gen = await callHandler(genRoute, fakeReq({ method: "POST", body: JSON.stringify(body) }));
      const rec: Record<string, any> = {
        genOk: gen.ok,
        genRaw: JSON.stringify(gen).slice(0, 160),
        hasTaskId: typeof gen.taskId === "string" && gen.taskId.length > 0,
      };
      const done = await pollUntil(async () => {
        const st = await callHandler(statusRoute, fakeReq({ url: `${ROUTES.reportGenerateStatus}?taskId=${encodeURIComponent(gen.taskId)}` }));
        return st.status === "done" || st.status === "failed" ? st : undefined;
      }, 5000, 5);
      rec.doneDefined = done !== undefined;
      rec.doneStatus = done?.status;
      rec.doneError = done?.error ?? "";
      rec.doneHasMeta = done?.meta !== undefined;
      genObs.push(rec);
      return done.meta;
    };
    obs.genObs = genObs;

    // d. 手动生成 daily → 202+taskId → 轮询 done → meta → 三件套就位
    const genMeta = await generateAndAwait({ period: "daily" });
    obs.genMetaOk = genMeta.ok;
    obs.genMetaPeriod = genMeta.period;
    obs.genMetaProvider = genMeta.provider;
    obs.genMetaModel = genMeta.model;
    obs.genMetaKeyIsDayKey = typeof genMeta.key === "string" && /^\d{4}-\d{2}-\d{2}$/.test(genMeta.key);
    obs.genMetaKey = genMeta.key;
    const htmlFile = join(reportsDir, `daily-${genMeta.key}.html`);
    const metaFile = join(reportsDir, `daily-${genMeta.key}.meta.json`);
    const indexFile = join(reportsDir, "index.jsonl");
    obs.reportHtmlExists = existsSync(htmlFile);
    obs.reportMetaExists = existsSync(metaFile);
    obs.reportIndexExists = existsSync(indexFile);
    const storedMeta = JSON.parse(readFileSync(metaFile, "utf8"));
    obs.storedMetaKey = storedMeta.key;
    const storedHtml = readFileSync(htmlFile, "utf8");
    obs.storedHtmlIsMinimalSkeleton = storedHtml.startsWith("<!doctype html>") && storedHtml.includes("dou-report-body");

    // e/f. 双断言：生成不入统计（方案 §2.3 显式断言）——生成前后 /trend 桶快照完全一致
    const trendAfter = await callHandler(trendRoute, fakeReq({ url: ROUTES.trend }));
    obs.trendAfterSeries = trendAfter.series;
    obs.trendBeforeSeries = trendBefore.series;
    obs.trendAfterSummary = trendAfter.summary;
    obs.trendBeforeSummary = trendBefore.summary;
    // 事件通道计数佐证：生成过程只经 llm.stream，无 session/event 派发
    obs.sessionEventListenerCount = (listeners.get("session/event") ?? []).length;

    // e. XSS 双层净化：恶意 LLM 正文 → detail 响应既无明文载体、也无实体化标签残留
    {
      const xssDir = mkdtempSync(join(tmpdir(), "dou-report-xss-"));
      const xssCtx = makeFakeCtx({
        llmStreamChunks: [
          { type: "text-delta", index: 0, text: "<script>alert(1)</script>安全正文<img onerror=x src=y>收尾" },
          { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
          { type: "finish", reason: "stop" },
        ],
      });
      await apply(xssCtx.ctx, { ...ISOLATED_CONFIG, historyDir: join(xssDir, "hist") });
      // #532：空窗口会 noData 短路不落盘——先向本 ctx 合成落在 daily 闭环窗口内的用量
      {
        const xssCfgRoute = xssCtx.routes.find((r) => r.path === ROUTES.reportConfig);
        const xssCfg = await callHandler(xssCfgRoute, fakeReq({ url: ROUTES.reportConfig }));
        const xssDue = previousClosedWindow("daily", xssCfg.config, Date.now());
        const [xy, xm, xd] = xssDue.endDay.split("-").map(Number);
        const xt = new Date(xy, xm - 1, xd, 12, 0, 0).getTime();
        const xssSess = { id: "sess-xss" };
        xssCtx.emitEvent("session/event", xssSess, { type: "request/header", seq: 1, time: xt, data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } }, reason: "initial" } });
        xssCtx.emitEvent("session/event", xssSess, { type: "assistant/message", seq: 2, time: xt, data: { turn: 1, step: 1, usage: { inputTokens: 80, outputTokens: 40 } } });
        await xssCtx.listeners.get("session/flush")[0]();
      }
      const xssGenRoute = xssCtx.routes.find((r) => r.path === ROUTES.reportGenerate);
      const xssStatusRoute = xssCtx.routes.find((r) => r.path === ROUTES.reportGenerateStatus);
      const xssGenRes = await callHandler(xssGenRoute, fakeReq({ method: "POST", body: JSON.stringify({ period: "daily" }) }));
      obs.xssGen202 = xssGenRes.ok;
      const xssDone = await pollUntil(async () => {
        const st = await callHandler(xssStatusRoute, fakeReq({ url: `${ROUTES.reportGenerateStatus}?taskId=${encodeURIComponent(xssGenRes.taskId)}` }));
        return st.status === "done" || st.status === "failed" ? st : undefined;
      }, 5000, 5);
      obs.xssDoneStatus = xssDone?.status;
      obs.xssDoneError = xssDone?.error ?? "";
      const xssGen = xssDone.meta;
      obs.xssGenOk = xssGen.ok;
      const xssDetail = await callHandler(
        xssCtx.routes.find((r) => r.path === ROUTES.reportDetail),
        fakeReq({ url: `${ROUTES.reportDetail}?period=daily&key=${encodeURIComponent(xssGen.key)}` }),
      );
      obs.xssDetailOk = xssDetail.ok;
      obs.xssDetailMetaOk = xssDetail.meta.ok;
      obs.xssNoRawScript = !xssDetail.html.includes("<script");
      obs.xssNoOnErrorAttr = !xssDetail.html.includes("onerror");
      obs.xssNoEntityScript = !xssDetail.html.includes("&lt;script");
      obs.xssKeepsText = xssDetail.html.includes("安全正文");
      for (const d of [...xssCtx.effects].reverse()) { try { d(); } catch { /* 忽略 */ } }
    }

    // f2. 趋势查询对生成免疫已由 f 覆盖；此处补 list/detail 读面
    const listPayload = await callHandler(listRoute, fakeReq({ url: ROUTES.reports }));
    obs.listOk = listPayload.ok;
    obs.listNonEmpty = Array.isArray(listPayload.reports) && listPayload.reports.length >= 1;
    obs.listFirstKey = listPayload.reports[0].key;

    const detail = await callHandler(detailRoute, fakeReq({ url: `${ROUTES.reportDetail}?period=daily&key=${encodeURIComponent(genMeta.key)}` }));
    obs.detailOk = detail.ok;
    obs.detailMetaOk = detail.meta.ok;
    obs.detailHtmlNonEmpty = typeof detail.html === "string" && detail.html.length > 0;

    // g. 手动生成推进 lastRun（防调度 tick 重复生成同窗）
    const lastRunFile = join(reportsDir, "last-run.json");
    obs.lastRunFileExists = existsSync(lastRunFile);
    const lastRun = JSON.parse(readFileSync(lastRunFile, "utf8"));
    obs.lastRunDaily = lastRun.daily;

    // ---------------------------------------------------------------- #633 分片 b B4：报告配置目录范围 round-trip（路由读写）
    {
      const withDirs = await callHandler(
        cfgRoute,
        fakeReq({ method: "POST", body: JSON.stringify({ daily: { enabled: true, time: "22:00" }, directories: ["/tmp/some/proj", "repo"], push: { enabled: false } }) }),
      );
      obs.withDirsOk = withDirs.ok;
      obs.withDirsDirectories = withDirs.config.directories;
      const readBack = await callHandler(cfgRoute, fakeReq({ url: ROUTES.reportConfig }));
      obs.readBackDirectories = readBack.config.directories;
      // 显式 all → 全部（空数组）
      const allDirs = await callHandler(
        cfgRoute,
        fakeReq({ method: "POST", body: JSON.stringify({ daily: { enabled: true, time: "22:00" }, directories: "all", push: { enabled: false } }) }),
      );
      obs.allDirsDirectories = allDirs.config.directories;
      // 非法形态 → 回退空数组
      const badDirs = await callHandler(
        cfgRoute,
        fakeReq({ method: "POST", body: JSON.stringify({ daily: { enabled: true, time: "22:00" }, directories: 42, push: { enabled: false } }) }),
      );
      obs.badDirsDirectories = badDirs.config.directories;
    }

    // ---------------------------------------------------------------- #633 分片 b C1：报告链路 byDirectory 端到端
    // f 步已注入会话用量（fake ctx 无 sessions store → 目录归未识别桶，落盘 dir 行），
    // 手动生成（d 步）的快照经 runner 接线 trend.dirRows()——验证落盘 meta/索引
    // 与生成链路不因目录维度抛错，且 /trend 目录查询面读得到落盘数据。
    {
      const UNK = "(unidentified)";
      const dirRowsRoute = trendRoute; // 同一路由：dir 分支读 aggregator 目录查询面
      const dirTrend = await callHandler(dirRowsRoute, fakeReq({ url: `${ROUTES.trend}?dir=${encodeURIComponent(UNK)}` }));
      obs.dirTrendTodayReachable = dirTrend.series.find((p) => p.key === dayKey(Date.now())) !== undefined;
      // 报告 meta（含 summary）已落盘且无路径形态（与 C2 出口约束一致）
      const metaOnDisk = JSON.parse(readFileSync(metaFile, "utf8"));
      obs.metaOnDiskKey = metaOnDisk.key;
      const metaText = readFileSync(metaFile, "utf8");
      obs.metaTextHasNoAbsolutePath = !metaText.includes("/home/") && !metaText.includes("C:\\");
    }

    // g2. #626 幂等短路 + force 强制重生成 + #625 status 守卫
    {
      const dailyLineCount = () => {
        const raw = readFileSync(indexFile, "utf8");
        return raw.split("\n").filter((l) => l.includes('"period":"daily"') && l.includes(`"key":"${genMeta.key}"`)).length;
      };
      const countBeforeForce = dailyLineCount();
      const again = await callHandler(genRoute, fakeReq({ method: "POST", body: JSON.stringify({ period: "daily" }) }));
      obs.againOk = again.ok;
      obs.againReused = again.reused;
      obs.againMetaKey = again.meta.key;
      obs.againLineCount = dailyLineCount();
      obs.countBeforeForce = countBeforeForce;
      // #629 P2 复用提示对称说明：200 直接复用路径的 reused 透传已由上方 again 断言覆盖；
      // executor 短路复用（202 任务化 → 执行前重查 index 命中 → task.reused）在 HTTP 面
      // 被路由层 200 短路先行遮蔽，正常流量下不可达，集成层不构造时序赌注（防 flake），
      // 该透传断言归位单元层（unit-report.test.ts 直调 handleReportStatus 覆盖）。
      const forceMeta = await generateAndAwait({ period: "daily", force: true });
      obs.forceMetaOk = forceMeta.ok;
      obs.forceMetaKey = forceMeta.key;
      obs.forceLineCount = dailyLineCount();
      const forceList = await callHandler(listRoute, fakeReq({ url: ROUTES.reports }));
      const dailies = forceList.reports.filter((m) => m.period === "daily" && m.key === genMeta.key);
      obs.forceListDailyCount = dailies.length;
      const bad1 = await callHandler(statusRoute, fakeReq({ url: `${ROUTES.reportGenerateStatus}?taskId=not-a-uuid` }));
      obs.statusBadUuidError = bad1.error;
      const bad2 = await callHandler(statusRoute, fakeReq({ url: `${ROUTES.reportGenerateStatus}?taskId=00000000-0000-4000-8000-000000000000` }));
      obs.statusUnknownTaskError = bad2.error;
    }

    // g3. #629 P2 交叉写者：启用 weekly（preset 走 updateLastRun 临界区）后 lastRun.daily 不丢
    {
      const saveWeekly = await callHandler(
        cfgRoute,
        fakeReq({ method: "POST", body: JSON.stringify({ daily: { enabled: true, time: "22:00" }, weekly: { enabled: true, time: "09:00", weekStartsOn: 1 }, push: { enabled: false } }) }),
      );
      obs.saveWeeklyOk = saveWeekly.ok;
      const lastRunAfter = JSON.parse(readFileSync(lastRunFile, "utf8"));
      obs.lastRunAfterDaily = lastRunAfter.daily;
      obs.lastRunAfterWeeklyIsString = typeof lastRunAfter.weekly === "string" && lastRunAfter.weekly.length > 0;
    }

    // g4. #629 P1 解析记忆化：重复读走缓存（计数器证明不重解析）+ 失效正确 + 路由不服务过期投影
    {
      // 直接向 index.jsonl 追加一行（size/mtime 双变 → 缓存必失效；新 generatedAt 最大 → 排序首位）
      appendFileSync(indexFile, `${JSON.stringify({ period: "daily", key: "2099-01-01", startDay: "2099-01-01", endDay: "2099-01-01", provider: "anthropic", model: "model-a", generatedAt: Date.now() + 1000000, ok: true })}\n`);
      const afterAppend = await callHandler(listRoute, fakeReq({ url: ROUTES.reports }));
      obs.afterAppendFirstKey = afterAppend.reports[0].key;
      // 计数器度量：清缓存后连续三读 → 恰好 1 次 miss + 2 次 hit（重复读不再线性重解析）
      __clearReportIndexCacheForTests();
      const s0 = __reportIndexCacheStatsForTests();
      await readReportIndex(histDir);
      await readReportIndex(histDir);
      await readReportIndex(histDir);
      const s1 = __reportIndexCacheStatsForTests();
      obs.indexCacheDelta = { misses: s1.misses - s0.misses, hits: s1.hits - s0.hits };
      __clearReportIndexCacheForTests(); // 清场，防跨块计数残留影响语义
    }

    // h. 路径隔离：reports 产物全部落在临时 historyRoot 下，无 undefined 段
    const produced = readdirSync(reportsDir);
    const PRODUCED_RE = /^(daily|weekly|monthly)-\d{4}-\d{2}(-\d{2})?(\.html|\.meta\.json)$|^index\.jsonl$|^last-run\.json$|^config\.json$/;
    obs.producedCount = produced.length;
    obs.producedWithUndefined = produced.filter((f) => f.includes("undefined"));
    obs.producedNotWhitelisted = produced.filter((f) => !PRODUCED_RE.test(f));
    obs.noUndefinedDirSegment = !existsSync(join(dir, "undefined"));

    // detail 守卫：period 枚举 + key 白名单（防路径穿越）
    {
      const bad1 = await callHandler(detailRoute, fakeReq({ url: `${ROUTES.reportDetail}?period=evil&key=2026-09-04` }));
      obs.detailInvalidPeriodError = bad1.error;
      const bad2 = await callHandler(detailRoute, fakeReq({ url: `${ROUTES.reportDetail}?period=daily&key=..%2F..%2Fevil` }));
      obs.detailTraversalKeyError = bad2.error;
      const bad3 = await callHandler(detailRoute, fakeReq({ url: `${ROUTES.reportDetail}?period=monthly&key=2026-09-04` }));
      obs.detailWrongPeriodKeyError = bad3.error;
      const bad4 = await callHandler(detailRoute, fakeReq({ url: `${ROUTES.reportDetail}?period=daily&key=2099-01-01` }));
      obs.detailNotFoundError = bad4.error;
    }

    // generate 守卫：非法 period 拒绝
    {
      const badGen = await callHandler(genRoute, fakeReq({ method: "POST", body: JSON.stringify({ period: "hourly" }) }));
      obs.generateInvalidPeriodError = badGen.error;
    }

    await (effects.at(-1) as () => Promise<void>)(); // 卸载（async disposer：trend 刷盘 + scheduler 停 tick）
  });

  it("报告四路由存在", () => {
    expect(obs.reportRoutesExist).toBeTruthy();
  });

  it("默认挂载（报告全关）不产生 reports/ 目录", () => {
    expect(obs.noReportsDirOnDefaultMount).toBeTruthy();
  });

  it("report-config GET ok", () => {
    expect(obs.defaultCfgOk).toBe(true);
  });

  it("默认 daily 关闭", () => {
    expect(obs.defaultDailyEnabled).toBe(false);
  });

  it("默认 weekly 关闭", () => {
    expect(obs.defaultWeeklyEnabled).toBe(false);
  });

  it("默认 monthly 关闭", () => {
    expect(obs.defaultMonthlyEnabled).toBe(false);
  });

  it("默认模板含 {stats} 占位", () => {
    expect(obs.defaultPromptTemplateHasStats).toBeTruthy();
  });

  it("providers 来自 llm.listProviders()", () => {
    expect(obs.defaultProvidersFromLlm).toBeTruthy();
  });

  it("report-config POST ok", () => {
    expect(obs.savedCfgOk).toBe(true);
  });

  it("保存后 daily 启用", () => {
    expect(obs.savedDailyEnabled).toBe(true);
  });

  it("触发时刻回显", () => {
    expect(obs.savedDailyTime).toBe("22:00");
  });

  it("POST 后 GET 回读一致", () => {
    expect(obs.rereadConfig).toEqual(obs.savedConfigSnapshot);
  });

  it("report-models 路由存在", () => {
    expect(obs.modelsRouteExists).toBeTruthy();
  });

  it("report-models 已知 provider ok", () => {
    expect(obs.modelsOkOk).toBe(true);
  });

  it("models 白名单字段映射（id/name）", () => {
    expect(obs.modelsWhitelist).toEqual([{ id: "model-a", name: "Model A" }]);
  });

  it("未知 provider 拒绝（与发现失败分报）", () => {
    expect(obs.modelsUnknown).toEqual({ ok: false, reason: "unknown-provider" });
  });

  it("缺 provider 参数拒绝", () => {
    expect(obs.modelsMissing).toEqual({ ok: false, reason: "unknown-provider" });
  });

  it("reportGenerateStatus 路由存在", () => {
    expect(obs.statusRouteExists).toBeTruthy();
  });

  it("generate ok（日报）", () => {
    expect(obs.genObs[0].genOk, `实际 ${obs.genObs[0].genRaw}`).toBe(true);
  });

  it("202 返回 taskId（日报）", () => {
    expect(obs.genObs[0].hasTaskId).toBeTruthy();
  });

  it("生成任务轮询完成（日报）", () => {
    expect(obs.genObs[0].doneDefined).toBeTruthy();
  });

  it("任务成功（日报）", () => {
    expect(obs.genObs[0].doneStatus, `实际 ${obs.genObs[0].doneStatus}${obs.genObs[0].doneError}`).toBe("done");
  });

  it("done 携带 meta（日报）", () => {
    expect(obs.genObs[0].doneHasMeta).toBeTruthy();
  });

  it("generate ok（force）", () => {
    expect(obs.genObs[1].genOk, `实际 ${obs.genObs[1].genRaw}`).toBe(true);
  });

  it("202 返回 taskId（force）", () => {
    expect(obs.genObs[1].hasTaskId).toBeTruthy();
  });

  it("生成任务轮询完成（force）", () => {
    expect(obs.genObs[1].doneDefined).toBeTruthy();
  });

  it("任务成功（force）", () => {
    expect(obs.genObs[1].doneStatus, `实际 ${obs.genObs[1].doneStatus}${obs.genObs[1].doneError}`).toBe("done");
  });

  it("done 携带 meta（force）", () => {
    expect(obs.genObs[1].doneHasMeta).toBeTruthy();
  });

  it("生成 meta.ok=true", () => {
    expect(obs.genMetaOk).toBe(true);
  });

  it("meta.period=daily", () => {
    expect(obs.genMetaPeriod).toBe("daily");
  });

  it("空 provider 解析为注册序首个", () => {
    expect(obs.genMetaProvider).toBe("anthropic");
  });

  it("空 model 解析为该 provider 首个", () => {
    expect(obs.genMetaModel).toBe("model-a");
  });

  it("窗口键为 day key 形态", () => {
    expect(obs.genMetaKeyIsDayKey).toBeTruthy();
  });

  it("报告 HTML 已落盘（0600 原子写）", () => {
    expect(obs.reportHtmlExists).toBeTruthy();
  });

  it("meta.json 已落盘", () => {
    expect(obs.reportMetaExists).toBeTruthy();
  });

  it("index.jsonl 已 append", () => {
    expect(obs.reportIndexExists).toBeTruthy();
  });

  it("meta 文件与响应一致", () => {
    expect(obs.storedMetaKey).toBe(obs.genMetaKey);
  });

  it("HTML 为最小文档骨架包裹", () => {
    expect(obs.storedHtmlIsMinimalSkeleton).toBeTruthy();
  });

  it("生成前后趋势序列逐桶一致（生成不产生 session 事件）", () => {
    expect(obs.trendAfterSeries).toEqual(obs.trendBeforeSeries);
  });

  it("生成前后窗口摘要一致（生成消耗不入用量统计）", () => {
    expect(obs.trendAfterSummary).toEqual(obs.trendBeforeSummary);
  });

  it("session/event 监听注册数不变（生成路径不新增事件源）", () => {
    expect(obs.sessionEventListenerCount).toBe(1);
  });

  it("XSS 用例生成 202", () => {
    expect(obs.xssGen202).toBe(true);
  });

  it("XSS 任务成功", () => {
    expect(obs.xssDoneStatus, `实际 ${obs.xssDoneStatus}${obs.xssDoneError}`).toBe("done");
  });

  it("XSS 用例生成成功", () => {
    expect(obs.xssGenOk).toBe(true);
  });

  it("XSS 用例 detail ok", () => {
    expect(obs.xssDetailOk).toBe(true);
  });

  it("XSS 用例 detail meta.ok=true", () => {
    expect(obs.xssDetailMetaOk).toBe(true);
  });

  it("detail html 不含明文 <script（第一层 escHtml 转义）", () => {
    expect(obs.xssNoRawScript).toBeTruthy();
  });

  it("detail html 不含 onerror 事件属性（第二层 sanitizeHtml 移除）", () => {
    expect(obs.xssNoOnErrorAttr).toBeTruthy();
  });

  it("detail html 无实体化 script 标签残留（#105③ 实体感知封闭）", () => {
    expect(obs.xssNoEntityScript).toBeTruthy();
  });

  it("正文文本保留（只删载体不删内容）", () => {
    expect(obs.xssKeepsText).toBeTruthy();
  });

  it("reports GET ok", () => {
    expect(obs.listOk).toBe(true);
  });

  it("历史索引非空", () => {
    expect(obs.listNonEmpty).toBeTruthy();
  });

  it("倒序：最新在前", () => {
    expect(obs.listFirstKey).toBe(obs.genMetaKey);
  });

  it("detail ok", () => {
    expect(obs.detailOk).toBe(true);
  });

  it("detail meta.ok=true", () => {
    expect(obs.detailMetaOk).toBe(true);
  });

  it("detail html 非空", () => {
    expect(obs.detailHtmlNonEmpty).toBeTruthy();
  });

  it("last-run.json 已落盘", () => {
    expect(obs.lastRunFileExists).toBeTruthy();
  });

  it("lastRun.daily === 窗口键", () => {
    expect(obs.lastRunDaily).toBe(obs.genMetaKey);
  });

  it("带 directories POST ok", () => {
    expect(obs.withDirsOk).toBe(true);
  });

  it("路由写入：directories basename 归一化保存", () => {
    expect(obs.withDirsDirectories).toEqual(["proj", "repo"]);
  });

  it("GET 回读 directories round-trip 一致", () => {
    expect(obs.readBackDirectories).toEqual(["proj", "repo"]);
  });

  it("显式 all → 空数组（全部目录语义）", () => {
    expect(obs.allDirsDirectories).toEqual([]);
  });

  it("非法 directories → 空数组（回退默认）", () => {
    expect(obs.badDirsDirectories).toEqual([]);
  });

  it("目录查询面：今日桶可达（dropPending 当日桶保留）", () => {
    expect(obs.dirTrendTodayReachable).toBeTruthy();
  });

  it("报告 meta 完整落盘（目录维度接入不破坏生成链路）", () => {
    expect(obs.metaOnDiskKey).toBe(obs.genMetaKey);
  });

  it("报告 meta 无绝对路径形态", () => {
    expect(obs.metaTextHasNoAbsolutePath).toBeTruthy();
  });

  it("同窗口再次生成 ok", () => {
    expect(obs.againOk).toBe(true);
  });

  it("未勾选 force → 幂等复用", () => {
    expect(obs.againReused).toBe(true);
  });

  it("复用同窗口 meta", () => {
    expect(obs.againMetaKey).toBe(obs.genMetaKey);
  });

  it("幂等复用不新增 index 记录（未调 LLM）", () => {
    expect(obs.againLineCount).toBe(obs.countBeforeForce);
  });

  it("force 重新生成 ok", () => {
    expect(obs.forceMetaOk).toBe(true);
  });

  it("force 覆盖同窗口", () => {
    expect(obs.forceMetaKey).toBe(obs.genMetaKey);
  });

  it("force 真正重新生成（index 新增一行，防假绿）", () => {
    expect(obs.forceLineCount).toBe(obs.countBeforeForce + 1);
  });

  it("读侧投影：#626 同窗口多版本 → 列表一行/窗口", () => {
    expect(obs.forceListDailyCount).toBe(1);
  });

  it("非 uuid taskId 拒绝", () => {
    expect(obs.statusBadUuidError).toBe("task-not-found");
  });

  it("合法 uuid 但未知任务 → 404", () => {
    expect(obs.statusUnknownTaskError).toBe("task-not-found");
  });

  it("weekly 启用保存 ok", () => {
    expect(obs.saveWeeklyOk).toBe(true);
  });

  it("preset 写 weekly 后 daily 字段保留（updateLastRun 临界区，#629 P2）", () => {
    expect(obs.lastRunAfterDaily).toBe(obs.genMetaKey);
  });

  it("weekly preset 键已写入（双写者字段并存）", () => {
    expect(obs.lastRunAfterWeeklyIsString).toBeTruthy();
  });

  it("append 后路由读到新行（stat 失效生效，不服务过期投影）", () => {
    expect(obs.afterAppendFirstKey).toBe("2099-01-01");
  });

  it("连续三读仅一次全量解析（#629 P1 记忆化生效，读次数与解析次数解耦）", () => {
    expect(obs.indexCacheDelta).toEqual({ misses: 1, hits: 2 });
  });

  it("reports 目录有产物", () => {
    expect(obs.producedCount).toBeGreaterThan(0);
  });

  it("产物文件名无 undefined 段", () => {
    expect(obs.producedWithUndefined, `实际 ${JSON.stringify(obs.producedWithUndefined)}`).toEqual([]);
  });

  it("产物文件名白名单形态", () => {
    expect(obs.producedNotWhitelisted, `实际 ${JSON.stringify(obs.producedNotWhitelisted)}`).toEqual([]);
  });

  it("无 undefined/ 目录段", () => {
    expect(obs.noUndefinedDirSegment).toBeTruthy();
  });

  it("非法 period 拒绝", () => {
    expect(obs.detailInvalidPeriodError).toBe("invalid-period");
  });

  it("穿越形态 key 拒绝（白名单正则）", () => {
    expect(obs.detailTraversalKeyError).toBe("invalid-key");
  });

  it("monthly 期传入 daily 形态 key 拒绝", () => {
    expect(obs.detailWrongPeriodKeyError).toBe("invalid-key");
  });

  it("合法形态但无产物 → 404", () => {
    expect(obs.detailNotFoundError).toBe("report-not-found");
  });

  it("generate 非法 period 拒绝", () => {
    expect(obs.generateInvalidPeriodError).toBe("invalid-period");
  });
});

// ---------------------------------------------------------------- #633 分片 b2 D2：双目录全链路（cwd 接入 → 聚合/过滤/图例/目录范围候选）

describe("#633 分片 b2 D2：双目录全链路", () => {
  const obs: Record<string, any> = {};

  beforeAll(async () => {
    // 独立 historyDir：磁盘分片全隔离（前序块零混入）
    const dir = mkdtempSync(join(tmpdir(), "dou-633-d2-"));
    // fake sessions store：官方契约面 get(id)?.header.cwd（apply 的 resolveCwd 消费同款）
    const cwdBySession = new Map([
      ["sess-d2-a", "/home/u/dsh-plugin-hub"],
      ["sess-d2-b", "/home/u/xiaozhuge"],
      // 无 cwd 会话：store 有行但 header.cwd 缺失 → 未识别桶（B2 数据面）
      ["sess-d2-none", undefined],
    ]);
    const fakeSession = (id) => ({
      get(sid) {
        const key = String(sid);
        if (!cwdBySession.has(key)) return undefined;
        return { header: { cwd: cwdBySession.get(key) } };
      },
    });

    const { ctx, routes, listeners, emitEvent } = makeFakeCtx();
    // 挂 sessions store：resolveCwd → ctx.sessions.get(...)（分片 a A1 接线路径）
    ctx.sessions = fakeSession("store");
    await apply(ctx, { ...ISOLATED_CONFIG, historyDir: join(dir, "hist") });
    const trendRoute = routes.find((r) => r.path === ROUTES.trend);
    const cfgRoute = routes.find((r) => r.path === ROUTES.reportConfig);
    obs.d2RoutesExist = trendRoute !== undefined && cfgRoute !== undefined;

    // 双目录 + 一个无 cwd 会话，各一次定稿调用（时间 = 今日，落当日明细分片）
    const t = Date.now();
    const today = dayKey(t);
    const emitCall = (sessionId, seqBase, provider, model, input, output) => {
      const s = { id: sessionId };
      emitEvent("session/event", s, { type: "request/header", seq: seqBase, time: t, data: { header: { config: { provider, model } }, reason: "initial" } });
      emitEvent("session/event", s, { type: "assistant/message", seq: seqBase + 1, time: t, data: { turn: 1, step: 1, usage: { inputTokens: input, outputTokens: output } } });
    };
    emitCall("sess-d2-a", 1, "deepseek", "deepseek-chat", 200, 100);   // dsh-plugin-hub 桶
    emitCall("sess-d2-b", 11, "openai", "gpt-x", 20, 10);              // xiaozhuge 桶
    emitCall("sess-d2-none", 21, "deepseek", "deepseek-chat", 5, 5);   // 未识别桶

    // 官方排空点先行刷盘（事件 → 分片；路由读内存聚合，与 b1 块同序）
    await listeners.get("session/flush")[0]();

    const DIR_A = "dsh-plugin-hub";
    const DIR_B = "xiaozhuge";
    const UNK = "(unidentified)";
    obs.DIR_A = DIR_A;
    obs.DIR_B = DIR_B;
    obs.UNK = UNK;

    // 1. 双目录聚合数值：byDir=1 全目录面三桶各归各值（不合并不覆盖，B1 可区分性）
    const allDirs = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?byDir=1` }));
    const allToday = allDirs.series.find((p) => p.key === today);
    obs.allTodayTotal = allToday.total;
    const partOf = (point, name) => point.parts.find((p) => p.provider === name)?.value ?? null;
    obs.partA = partOf(allToday, DIR_A);
    obs.partB = partOf(allToday, DIR_B);
    obs.partUnk = partOf(allToday, UNK);
    obs.dirLegend = allDirs.dirs.map((d) => d.dir).sort();

    // 2. dir 过滤面：过滤后数值 = 该目录子集（A=300 / B=30 / 未识别=10，互不串桶）
    const onlyA = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?dir=${encodeURIComponent(DIR_A)}` }));
    obs.onlyATodayTotal = onlyA.series.find((p) => p.key === today).total;
    obs.onlyASummaryTotal = onlyA.summary.total;
    const onlyB = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?dir=${encodeURIComponent(DIR_B)}` }));
    obs.onlyBTodayTotal = onlyB.series.find((p) => p.key === today).total;
    const onlyUnk = await callHandler(trendRoute, fakeReq({ url: `${ROUTES.trend}?dir=${encodeURIComponent(UNK)}` }));
    obs.onlyUnkTodayTotal = onlyUnk.series.find((p) => p.key === today).total;

    // 3. provider 面零回归：cwd 接入不改既有 day×provider×model 聚合数值（A1 红线）
    const providerFace = await callHandler(trendRoute, fakeReq({ url: ROUTES.trend }));
    obs.providerFaceTodayTotal = providerFace.series.find((p) => p.key === today).total;
    obs.providerFaceDirs = providerFace.dirs;
    obs.providerFaceDir = providerFace.dir;

    // 4. report-config GET 附目录候选（B4 数据源）：双目录 + 未识别桶、calls 降序、basename 形态
    const cfgBody = await callHandler(cfgRoute, fakeReq({ url: ROUTES.reportConfig }));
    obs.cfgDirsIsThree = Array.isArray(cfgBody.dirs) && cfgBody.dirs.length === 3;
    obs.cfgDirsSorted = cfgBody.dirs.map((d) => d.dir).sort();
    obs.cfgDirsWithSeparator = cfgBody.dirs.filter((d) => d.dir.includes("/") || d.dir.includes("\\")).map((d) => d.dir);
    // eslint-disable-next-line no-control-regex
    obs.cfgDirsWithControlChars = cfgBody.dirs.filter((d) => /[\u0000-\u001f\u007f-\u009f]/.test(d.dir)).map((d) => d.dir);
    obs.topByCallsDir = cfgBody.dirs[0].dir;

    // 5. directories 配置 round-trip（路由侧四同步已在 b1 断言；此处验证候选与保存值同键域）
    const scoped = await callHandler(
      cfgRoute,
      fakeReq({ method: "POST", body: JSON.stringify({ directories: [DIR_A, UNK], push: { enabled: false } }) }),
    );
    obs.scopedDirectories = scoped.config.directories;
  });

  it("D2 块路由存在", () => {
    expect(obs.d2RoutesExist).toBeTruthy();
  });

  it("双目录全量 = 200+100+20+10+5+5 = 340", () => {
    expect(obs.allTodayTotal).toBe(340);
  });

  it("目录 A 段 = 300（basename 桶归属）", () => {
    expect(obs.partA).toBe(300);
  });

  it("目录 B 段 = 30", () => {
    expect(obs.partB).toBe(30);
  });

  it("无 cwd 会话 = 10 入未识别桶（不消失不计入具名目录）", () => {
    expect(obs.partUnk).toBe(10);
  });

  it("dirs 图例 = 双具名目录 + 未识别桶并集（多目录可区分）", () => {
    expect(obs.dirLegend).toEqual([obs.DIR_A, obs.DIR_B, obs.UNK].sort());
  });

  it("dir=A 过滤 → total=300（子集口径）", () => {
    expect(obs.onlyATodayTotal).toBe(300);
  });

  it("dir=A 汇总卡 = 300", () => {
    expect(obs.onlyASummaryTotal).toBe(300);
  });

  it("dir=B 过滤 → total=30", () => {
    expect(obs.onlyBTodayTotal).toBe(30);
  });

  it("dir=未识别桶 过滤 → total=10（桶键同为合法过滤值）", () => {
    expect(obs.onlyUnkTodayTotal).toBe(10);
  });

  it("provider 面总量不变 = 340", () => {
    expect(obs.providerFaceTodayTotal).toBe(340);
  });

  it("provider 面 dirs 恒空数组（现状形状零变化）", () => {
    expect(obs.providerFaceDirs).toEqual([]);
  });

  it("provider 面 dir 回显 null", () => {
    expect(obs.providerFaceDir).toBe(null);
  });

  it("GET /report-config 附 dirs 候选（含未识别桶）", () => {
    expect(obs.cfgDirsIsThree).toBeTruthy();
  });

  it("候选含双具名目录 + 未识别桶", () => {
    expect(obs.cfgDirsSorted).toEqual([obs.DIR_A, obs.DIR_B, obs.UNK].sort());
  });

  it("候选目录为 basename 形态（无路径分隔符）", () => {
    expect(obs.cfgDirsWithSeparator, `实际 ${JSON.stringify(obs.cfgDirsWithSeparator)}`).toEqual([]);
  });

  it("候选目录无 C0+DEL+C1 控制字符（P2 listDirs 出口净化收口）", () => {
    expect(obs.cfgDirsWithControlChars, `实际 ${JSON.stringify(obs.cfgDirsWithControlChars)}`).toEqual([]);
  });

  it("候选 calls 降序：目录 A（3 calls）居首", () => {
    expect(obs.topByCallsDir).toBe(obs.DIR_A);
  });

  it("按候选键保存 round-trip（basename/未识别桶键直存）", () => {
    expect(obs.scopedDirectories).toEqual([obs.DIR_A, obs.UNK]);
  });
});

// ---------------------------------------------------------------- #633 分片 b2 D2：客户端源码契约断言（目录控件存在性 + 未识别口径 + B4 多选）

describe("#633 分片 b2 D2：客户端源码契约断言", () => {
  beforeAll(() => {
    const pkgDir = join(here, "..", "..");
    clientContractObs.trendSource = readFileSync(join(pkgDir, "src/client/trend.tsx"), "utf8");
    clientContractObs.reportSource = readFileSync(join(pkgDir, "src/client/report.tsx"), "utf8");
    clientContractObs.mathSource = readFileSync(join(pkgDir, "src/client/trend-math.ts"), "utf8");
    clientContractObs.routesSource = readFileSync(join(pkgDir, "src/domain2/routes/ui.ts"), "utf8");
    clientContractObs.localesSource = readFileSync(join(pkgDir, "src/client/locales.ts"), "utf8");
    clientContractObs.listDirsSource = readFileSync(join(pkgDir, "src/domain2/execute/list-dirs.ts"), "utf8");
  });

  // B1：趋势面板目录筛选控件存在（select + dirs 数据源 + 全部目录/byDir 请求面）
  it("趋势面板存在目录筛选下拉（aria-label 哨兵）", () => {
    expect(clientContractObs.trendSource.includes('aria-label={t("trendDirLabel")}')).toBeTruthy();
  });

  it("目录下拉首项「全部目录」", () => {
    expect(clientContractObs.trendSource.includes("trendDirAll")).toBeTruthy();
  });

  it("目录段 id 经 dirStackId 防御归一（异常值不进渲染面）", () => {
    expect(clientContractObs.trendSource.includes("dirStackId")).toBeTruthy();
  });

  // #633 复核闸 P0：请求参数三态互斥封装为 trend-math.trendRequestParams（断言锚随实现下沉）
  it("/trend 请求参数构造为纯函数（P0 交叉面杜绝）", () => {
    expect(clientContractObs.mathSource.includes("export function trendRequestParams")).toBeTruthy();
  });

  it("选定目录 → 请求带 dir 参数", () => {
    expect(clientContractObs.mathSource.includes('params.set("dir", dirFilter)')).toBeTruthy();
  });

  it("全部目录 → byDir=1（三态互斥：adapter 过滤面零目录参数）", () => {
    expect(clientContractObs.mathSource.includes('else if (provider === "") params.set("byDir", "1")')).toBeTruthy();
  });

  // P0①目录下拉可达性：渲染条件改状态真值（shouldShowDirSelect，未选适配器恒可见）；
  // 旧条件 dirMode 恒真致下拉仅加载瞬间闪现——负向断言防回归
  it("目录下拉可见性 = shouldShowDirSelect（未选适配器恒可见）", () => {
    expect(clientContractObs.trendSource.includes("shouldShowDirSelect(provider)")).toBeTruthy();
  });

  it("byModel checkbox 可见性 = shouldShowByModel（adapter 过滤且未选目录）", () => {
    expect(clientContractObs.trendSource.includes("shouldShowByModel(provider, dirFilter)")).toBeTruthy();
  });

  it("旧 dirMode 恒真渲染条件已移除（P0 回归护栏）", () => {
    expect(!clientContractObs.trendSource.includes("dirMode ? null")).toBeTruthy();
  });

  it("选适配器联动清目录（两维互斥：数据面切换）", () => {
    expect(clientContractObs.trendSource.includes('setDirFilter("")')).toBeTruthy();
  });

  it("选目录联动清适配器（两维互斥：数据面切换）", () => {
    expect(clientContractObs.trendSource.includes('setProvider("")')).toBeTruthy();
  });

  it("宿主 /trend 支持 byDir=1（客户端数据源契约）", () => {
    expect(clientContractObs.routesSource.includes('url.searchParams.get("byDir") === "1"')).toBeTruthy();
  });

  // B2：未识别桶恒出现 + 口径注明
  it("未识别桶图例/tooltip 注明口径", () => {
    expect(clientContractObs.trendSource.includes("trendDirUnidentifiedNote")).toBeTruthy();
  });

  it("客户端未识别桶键与宿主 TREND_UNIDENTIFIED 字面一致", () => {
    expect(clientContractObs.mathSource.includes('export const DIR_UNIDENTIFIED = "(unidentified)"')).toBeTruthy();
  });

  // #633 复核闸 P2：目录面文案/title/出口净化（顺带批锚点）
  it("Top 汇总卡目录面用目录面标签（trendCardTopDir）", () => {
    expect(clientContractObs.trendSource.includes('dirMode ? t("trendCardTopDir") : t("trendCardTop")')).toBeTruthy();
  });

  it("图例 title 与可见文本同源净化（不再直用原始键）", () => {
    expect(clientContractObs.trendSource.includes('dirNeedsScopeNote(id) ? t("trendDirUnidentifiedNote") : dirDisplayLabel(id)')).toBeTruthy();
  });

  it("locales 中英对称新增目录面 Top 标签", () => {
    expect(clientContractObs.localesSource.includes('trendCardTopDir: "Top 目录"')).toBeTruthy();
  });

  it("B4 空候选时「全部目录」checkbox 禁用（空=全部语义不变）", () => {
    expect(clientContractObs.reportSource.includes("disabled={dirOptions.length === 0}")).toBeTruthy();
  });

  // D8：listDirs 出口净化从 apply 闭包移入 list-dirs.ts 工厂（装配层零隐藏可变状态）
  it("listDirs 出口过 sanitizeDirName（旁路污染分片行防御收口，D8 移入工厂）", () => {
    expect(clientContractObs.listDirsSource.includes("sanitizeDirName(r.dir) ?? TREND_UNIDENTIFIED")).toBeTruthy();
  });

  // B4：设置页报告目录范围多选（GET dirs 回填 + directories draft + 保存 round-trip 消费点）
  it("报告配置卡存在目录范围多选（i18n 哨兵）", () => {
    expect(clientContractObs.reportSource.includes("reportDirectories")).toBeTruthy();
  });

  it("目录候选经 GET dirs 回填", () => {
    expect(clientContractObs.reportSource.includes("setDirOptions")).toBeTruthy();
  });

  it("多选结果写进 draft.directories（POST 保存体）", () => {
    expect(clientContractObs.reportSource.includes("directories:")).toBeTruthy();
  });

  it("保存后影响报告口径的提示文案存在", () => {
    expect(clientContractObs.reportSource.includes("reportDirectoriesHintScoped")).toBeTruthy();
  });
});

// 恢复真实环境变量（测试收尾）
afterAll(() => {
  for (const k of SAVED_ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    else delete process.env[k];
  }
  delete process.env.OPENCODE_GO_API_KEY_TEST_ABSENT;
});
