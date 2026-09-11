// @ts-nocheck（e2e/集成面类型化技术债：桩对象密集，暂不参与 test/tsconfig 编译）
/**
 * dsh-notifier — e2e：边缘路径与清理生命周期（热点补强）。
 *
 * 覆盖：生命周期 disposer 清理、readBody async-iterator 分支、审批超时提醒、
 * 通知失败容错（catch 不崩）、完成聚合类型切换、错误合并 ≥3 条 shift、
 * disposed 清理 turn 去重、hookUserQuestions 服务缺失/抛错容错、
 * 无状态 idle 不误报。
 */
import { join } from "node:path";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeNotifier, makeFakeCtx, agentWithTitle, makeRes, fakeReq, waitForHistory, turnPair, quietWindowNow } from "../helpers.ts";
import { ROUTES, apply } from "../../src/index.ts";

let work: string;
beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "dnotify-e2e-edge-"));
});
afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

// ── 1. 生命周期清理：ctx.effect disposer 触发后，路由/监听器 disposer 被调用 ──
async function lifecycleFixture() {
  const routeDispCalled = new Set();
  const listenerDispCalled = new Set();
  const effectDisposers = [];
  let listenerCount = 0;
  const { ctx, listeners } = makeFakeCtx({
    webServer: {
      register(route) {
        routeDispCalled.add(route.path);
        return () => routeDispCalled.delete(route.path);
      },
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      const idx = listenerCount++;
      return () => listenerDispCalled.add(idx);
    },
    effect(fn) {
      const disp = fn();
      if (typeof disp === "function") effectDisposers.push(disp);
      return () => {};
    },
  });
  await apply(ctx, { enabled: true, toastScript: join(work, "lifecycle-toast.ps1"), historyFile: join(work, "lifecycle-history.jsonl") });
  return { routeDispCalled, listenerDispCalled, effectDisposers, listeners };
}

describe("生命周期清理：ctx.effect disposer", () => {
  it("7 条路由注册（M2 增 status/kinds）", async () => {
    expect((await lifecycleFixture()).routeDispCalled.size).toBe(7);
  });

  it("清理后路由 disposer 全部调用", async () => {
    const f = await lifecycleFixture();
    // 调用所有 effect disposer（清理顺序）
    for (const disp of f.effectDisposers) disp();
    expect(f.routeDispCalled.size).toBe(0);
  });

  it("清理后监听器 disposer 全部调用", async () => {
    const f = await lifecycleFixture();
    for (const disp of f.effectDisposers) disp();
    expect(f.listenerDispCalled.size >= 5).toBeTruthy();
  });
});

// ── 2. readBody async-iterator 分支（config PUT 走 web streams）──
/** 构造 async-iterable req（有 Symbol.asyncIterator，无 .on）。 */
function asyncIterRequest() {
  const body = JSON.stringify({ patch: { notifyAsk: false } });
  const chunks = [Buffer.from(body)];
  let idx = 0;
  return {
    method: "PUT",
    url: "/",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080" },
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (idx < chunks.length) return Promise.resolve({ value: chunks[idx++], done: false });
      return Promise.resolve({ value: undefined, done: true });
    },
  };
}

async function putViaAsyncIterator(tag) {
  const { routes } = await makeNotifier(work, { historyFile: join(work, `async-iter-hist-${tag}.jsonl`) });
  const configRoute = routes.find((r) => r.path === ROUTES.config);
  const { rec, res } = makeRes();
  await configRoute.handler(asyncIterRequest(), res);
  return rec;
}

describe("readBody async-iterator 分支", () => {
  it("async-iter req 无 .on 方法", () => {
    expect(typeof asyncIterRequest().on).toBe("undefined");
  });

  it("async-iterator 分支 PUT 返回 200", async () => {
    expect((await putViaAsyncIterator("a")).status).toBe(200);
  });

  it("async-iterator 分支解析成功", async () => {
    expect(JSON.parse((await putViaAsyncIterator("b")).text).user.notifyAsk).toBe(false);
  });
});

// ── 3. 审批超时提醒（askRemindMin > 0 分支）──
/**
 * 透明代理 setTimeout：记录调用但仍转发真实实现（还原于 finally）。
 * 返回 { askTimer, outcome, infos }。
 */
async function askRemindFixture() {
  const capturedTimers = [];
  const origSet = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...args) => {
    const timer = origSet(cb, ms, ...args);
    capturedTimers.push({ ms, timer });
    return timer;
  };
  try {
    const infos = [];
    const { listeners } = await makeNotifier(work, { askRemindMin: 1, historyFile: join(work, "ask-remind-hist.jsonl") }, {
      logger: { warn: (m) => { infos.push(`warn: ${m}`); }, info: (t) => infos.push(t) },
    });
    // 清理 apply 阶段的 timer 记录（execFile timeout 等）
    capturedTimers.length = 0;
    const approval = listeners.get("approval/request")[0];
    const askReq = { toolName: "pwsh", agent: agentWithTitle("remind-1", "超时审批测试"), reason: "test" };
    const nextPromise = approval(askReq, async () => "reminded");
    const askTimer = capturedTimers.find((t) => t.ms === 60000);
    const outcome = await nextPromise;
    return { askTimer, outcome, infos };
  } finally {
    globalThis.setTimeout = origSet;
  }
}

describe("审批超时提醒（askRemindMin > 0）", () => {
  it("askRemindMin > 0 注册了 60000ms 定时器", async () => {
    expect((await askRemindFixture()).askTimer).toBeTruthy();
  });

  it("next 结果透传", async () => {
    expect((await askRemindFixture()).outcome).toBe("reminded");
  });
});

// ── 4. 通知失败容错：notify 抛错时 handler 不崩，catch → warn → 仍继续后续逻辑 ──
/** 序列：approval → status(idle) → error → turn-stopping（logger.info 恒抛）。 */
async function notifyFailureFixture() {
  const warns = [];
  // 启用 notifyTurnEnd 以使 turn-stopping 进入通知路径（默认关）
  const { listeners } = await makeNotifier(work, { notifyTurnEnd: true, historyFile: join(work, "fail-hist.jsonl") }, {
    logger: {
      info: () => { throw new Error("notify failed"); },
      warn: (m) => { warns.push(m); },
    },
  });
  const approval = listeners.get("approval/request")[0];
  const status = listeners.get("agent/status")[0];
  const error = listeners.get("agent/error")[0];
  const turnStop = listeners.get("agent/turn-stopping")[0];

  // approval/request：notify 抛错 → catch → warn → 仍转发 next
  const outcome = await approval({ toolName: "bash", agent: { id: "fail-1" }, reason: "test" }, async () => "next-result");
  const fail2 = turnPair("fail-2", "出错任务", {}, { turn: 1 });
  status({ agent: fail2.running, status: "running" });
  status({ agent: fail2.idle, status: "idle" });
  error({ agent: { id: "fail-3" }, turn: 1, error: new Error("test error") });
  await turnStop({ agent: { id: "fail-4" }, turn: 1 });
  return { outcome, warns };
}

describe("通知失败容错：notify 抛错时 handler 不崩（catch → warn）", () => {
  let f: Awaited<ReturnType<typeof notifyFailureFixture>>;

  beforeAll(async () => {
    f = await notifyFailureFixture();
  });

  it("notify 抛错后 next 仍转发", () => {
    expect(f.outcome).toBe("next-result");
  });

  it("approval notify 失败时 warn 记录", () => {
    expect(f.warns.some((w) => w.includes("通知失败"))).toBeTruthy();
  });

  it("status notify 失败时 warn 记录", () => {
    expect(f.warns.some((w) => w.includes("agent/status"))).toBeTruthy();
  });

  it("error notify 失败时 warn 记录", () => {
    expect(f.warns.some((w) => w.includes("agent/error"))).toBeTruthy();
  });

  it("turn-stopping notify 失败时 warn 记录", () => {
    expect(f.warns.some((w) => w.includes("turn-stopping"))).toBeTruthy();
  });
});

// ── 5. 完成聚合类型切换（done → subagent-done 混合）──
/** 主任务完成（done 即时通知，doneBatch 开始）。 */
async function mergeKindFirst() {
  const infos = [];
  const { listeners } = await makeNotifier(work, { doneMergeWindowMs: 500, notifySubagentDone: true, historyFile: join(work, "merge-kind-hist.jsonl") }, {
    logger: { warn: () => {}, info: (t) => infos.push(t) },
  });
  const status = listeners.get("agent/status")[0];
  const mk1 = turnPair("mk-1", "主任务", {}, { turn: 1 });
  status({ agent: mk1.running, status: "running" });
  status({ agent: mk1.idle, status: "idle" });
  return infos;
}

/** 主任务 + 子代理完成（kind 不同 → flushDoneMerge（count=1 不补发）+ 即时 subagent-done）。 */
async function mergeKindSwitch() {
  const infos = [];
  const { listeners } = await makeNotifier(work, { doneMergeWindowMs: 500, notifySubagentDone: true, historyFile: join(work, "merge-kind-hist.jsonl") }, {
    logger: { warn: () => {}, info: (t) => infos.push(t) },
  });
  const status = listeners.get("agent/status")[0];
  const mk1 = turnPair("mk-1", "主任务", {}, { turn: 1 });
  status({ agent: mk1.running, status: "running" });
  status({ agent: mk1.idle, status: "idle" });
  const mk2 = turnPair("mk-2", "子代理", { subagent: true }, { turn: 1 });
  status({ agent: mk2.running, status: "running" });
  status({ agent: mk2.idle, status: "idle" });
  return infos;
}

describe("完成聚合类型切换（done → subagent-done）", () => {
  it("首条 done 即时通知", async () => {
    const infos = await mergeKindFirst();
    expect(infos.filter((t) => /done/.test(t)).length).toBe(1);
  });

  it("类型切换后 done 不重复", async () => {
    const infos = await mergeKindSwitch();
    expect(infos.filter((t) => /: done /.test(t)).length).toBe(1);
  });

  it("子代理完成即时通知（subagent-done）", async () => {
    const infos = await mergeKindSwitch();
    expect(infos.filter((t) => /: subagent-done /.test(t)).length).toBe(1);
  });
});

// ── 6. error 合并窗口 ≥3 条 shift（lastMessages 收尾 2 条）──
/** 4 条错误在同一个窗口（仅首条通知）。 */
async function mergeShiftFirst() {
  const infos = [];
  const { listeners } = await makeNotifier(work, { errorMergeWindowMs: 100, historyFile: join(work, "merge-shift-hist.jsonl") }, {
    logger: { warn: () => {}, info: (t) => infos.push(t) },
  });
  const error = listeners.get("agent/error")[0];
  error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e1") });
  error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e2") });
  error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e3") });
  error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e4") });
  return infos;
}

describe("error 合并窗口 ≥3 条 shift（lastMessages 收尾 2 条）", () => {
  it("4 条错误只通知 1 条（窗口内合并）", async () => {
    const infos = await mergeShiftFirst();
    expect(infos.filter((t) => /error/.test(t)).length).toBe(1);
  });
});

describe("error 合并窗口过期后：mergedCount=3 且 mergedErrors shift 收尾 2 条", () => {
  let mergedInfo: string;

  beforeAll(async () => {
    const infos = [];
    const { listeners } = await makeNotifier(work, { errorMergeWindowMs: 100, historyFile: join(work, "merge-shift-hist-3.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const error = listeners.get("agent/error")[0];
    error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e1") });
    error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e2") });
    error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e3") });
    error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e4") });
    await new Promise((resolve) => setTimeout(resolve, 350));
    error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e5") });
    mergedInfo = infos.filter((t) => /error/.test(t) && t.includes("同类错误"))[0];
  });

  it("窗口过期后通知携带合并计数 3", () => {
    expect(mergedInfo?.includes("另有 3 条同类错误")).toBeTruthy();
  });

  it("shift 后 e3 保留在 mergedErrors", () => {
    expect(mergedInfo?.includes("e3")).toBeTruthy();
  });

  it("shift 后 e4 保留在 mergedErrors", () => {
    expect(mergedInfo?.includes("e4")).toBeTruthy();
  });

  it("e2 被 shift 移出 mergedErrors", () => {
    expect(!mergedInfo?.includes("e2")).toBeTruthy();
  });
});

// ── 7. agent/disposed 清理 turnNotified 前缀 ──
/** 基础夹具（notifyTurnEnd 开）。 */
async function disposedTurnFixture() {
  const infos = [];
  const { listeners } = await makeNotifier(work, { notifyTurnEnd: true, historyFile: join(work, "disp-turn-hist.jsonl") }, {
    logger: { warn: () => {}, info: (t) => infos.push(t) },
  });
  return { infos, turnStop: listeners.get("agent/turn-stopping")[0], disposed: listeners.get("agent/disposed")[0] };
}

describe("agent/disposed 清理 turnNotified 前缀", () => {
  it("首轮 turn-stopping 通知", async () => {
    const f = await disposedTurnFixture();
    await f.turnStop({ agent: { id: "disp-1" }, turn: 1 });
    expect(f.infos.filter((t) => /turn-end/.test(t)).length).toBe(1);
  });

  it("去重生效", async () => {
    const f = await disposedTurnFixture();
    await f.turnStop({ agent: { id: "disp-1" }, turn: 1 });
    // 同轮重复 → 不通知（去重生效）
    await f.turnStop({ agent: { id: "disp-1" }, turn: 1 });
    expect(f.infos.filter((t) => /turn-end/.test(t)).length).toBe(1);
  });

  it("disposed 清理后重发通知", async () => {
    const f = await disposedTurnFixture();
    await f.turnStop({ agent: { id: "disp-1" }, turn: 1 });
    await f.turnStop({ agent: { id: "disp-1" }, turn: 1 });
    // disposed 清理后 → 再次通知（去重条目被清除）
    f.disposed({ agent: { id: "disp-1" } });
    await f.turnStop({ agent: { id: "disp-1" }, turn: 1 });
    expect(f.infos.filter((t) => /turn-end/.test(t)).length).toBe(2);
  });

  it("agent.id 为 undefined 时不抛", async () => {
    const f = await disposedTurnFixture();
    expect(() => {
      f.disposed({ agent: {} });
      f.disposed({ agent: {} });
    }).not.toThrow();
  });
});

// ── 8. hookUserQuestions：ctx.get 抛出 → 静默容错 ──
async function hookFailFixture() {
  const { listeners } = await makeNotifier(work, { historyFile: join(work, "hook-fail-hist.jsonl") }, {
    get: () => { throw new Error("service not ready"); },
    logger: { warn: () => {}, info: () => {} },
  });
  return { listeners };
}

describe("hookUserQuestions：ctx.get 抛出 → 静默容错", () => {
  it("apply 成功，internal/service 监听器已注册", async () => {
    // apply 不应抛异常
    expect(!!(await hookFailFixture()).listeners.get("internal/service")[0]).toBeTruthy();
  });

  it("internal/service 触发时 ctx.get 抛错不崩", async () => {
    // internal/service 事件触发 hookUserQuestions → 同样静默
    const svcHandler = (await hookFailFixture()).listeners.get("internal/service")[0];
    expect(() => svcHandler("userQuestions", undefined)).not.toThrow();
  });
});

// ── 9. 无状态 idle：无 running 记录时 idle 不误报 ──
describe("无状态 idle 不误报", () => {
  it("无 running 记录的 idle 不通知", async () => {
    const infos = [];
    const { listeners } = await makeNotifier(work, { historyFile: join(work, "noop-idle-hist.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    listeners.get("agent/status")[0]({ agent: agentWithTitle("noop-1", "从未 running"), status: "idle" });
    expect(infos.length).toBe(0);
  });
});

// ── 10. 免打扰拦截 + 勾选 error 豁免 → 窗口内再报错必须通知 ──
// 动态窗口：写死 "00:00"/"23:59" 在半开区间镜下 23:59 这一分钟不命中
// （UTC 边缘必炸，run 33282203798 根因）；围绕当前时间 ±2 分钟恒命中。
/** 免打扰开启（allowKinds 不含 error）+ 第一条错误。 */
async function quietErrorFirst() {
  const infos = [];
  const { listeners, routes } = await makeNotifier(work, { errorMergeWindowMs: 60000, quietHours: { ...quietWindowNow(), allowKinds: ["ask"] }, historyFile: join(work, "qh-error-hist-1.jsonl") }, {
    logger: { warn: () => {}, info: (t) => infos.push(t) },
  });
  const error = listeners.get("agent/error")[0];
  // 第一条错误：免打扰拦截，errorMerge 不开窗
  error({ agent: { id: "qh-e1" }, turn: 1, error: new Error("err1") });
  return { infos, error, routes, configRoute: routes.find((r) => r.path === ROUTES.config), historyRoute: routes.find((r) => r.path === ROUTES.history) };
}

/** 通过 PUT /config 模拟面板操作，开启 error 豁免。 */
async function putErrorAllowlist(configRoute, qhAll) {
  const { rec: putRec, res: putRes } = makeRes();
  const newBody = Buffer.from(JSON.stringify({ patch: { quietHours: { ...qhAll, allowKinds: ["ask", "error"] } } }));
  await configRoute.handler({
    method: "PUT",
    url: "/",
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "content-type": "application/json" },
    on: (evt, cb) => { if (evt === "data") cb(newBody); if (evt === "end") cb(); },
  }, putRes);
  return putRec;
}

/** 第一条（拦截）→ PUT 开豁免 → 重置计数 → 第二条错误。 */
async function quietErrorAfterAllow() {
  const qhAll = quietWindowNow();
  const f = await quietErrorFirst();
  await putErrorAllowlist(f.configRoute, qhAll);
  // 重置 info 计数
  f.infos.length = 0;
  // 第二条错误：窗口内（距上一条 < 60s），但无窗口（上一条被拦截未开窗），应正常通知
  f.error({ agent: { id: "qh-e1" }, turn: 1, error: new Error("err2") });
  return f;
}

describe("免打扰拦截错误：不发通知但留拦截日志", () => {
  it("免打扰拦截时不发实际通知", async () => {
    const f = await quietErrorFirst();
    expect(f.infos.filter((t) => /error/.test(t) && !t.includes("被免打扰拦截")).length).toBe(0);
  });

  it("被拦截记录日志", async () => {
    const f = await quietErrorFirst();
    expect(f.infos.some((t) => t.includes("被免打扰拦截"))).toBeTruthy();
  });

  it("被拦截的错误落 suppressed:quiet 历史", async () => {
    const f = await quietErrorFirst();
    const hist1 = await waitForHistory(f.historyRoute, (r) => r.some((e) => e.kind === "error" && e.suppressed === "quiet"));
    expect(hist1.some((e) => e.kind === "error" && e.suppressed === "quiet")).toBeTruthy();
  });
});

describe("PUT /config 开启 error 豁免", () => {
  it("PUT /config 返回 200", async () => {
    const f = await quietErrorFirst();
    expect((await putErrorAllowlist(f.configRoute, quietWindowNow())).status).toBe(200);
  });
});

describe("开启 error 豁免后窗口内错误正常通知", () => {
  it("开启 error 豁免后错误正常通知", async () => {
    expect((await quietErrorAfterAllow()).infos.filter((t) => /error/.test(t) && !t.includes("被免打扰拦截")).length).toBe(1);
  });

  it("通知内容包含 err2", async () => {
    expect((await quietErrorAfterAllow()).infos.some((t) => /error/.test(t) && t.includes("err2"))).toBeTruthy();
  });
});

// ── 11. 合并被吞的错误落 suppressed: "merged" 历史 ──
async function mergedHistoryFixture() {
  const infos = [];
  const { listeners, routes } = await makeNotifier(work, { errorMergeWindowMs: 60000, historyFile: join(work, "merged-hist.jsonl") }, {
    logger: { warn: () => {}, info: (t) => infos.push(t) },
  });
  const error = listeners.get("agent/error")[0];
  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  // 第一条错误：开窗
  error({ agent: { id: "mh-1" }, turn: 1, error: new Error("first") });
  return { infos, error, historyRoute };
}

describe("合并被吞的错误落 suppressed: merged 历史", () => {
  it("首条错误通知", async () => {
    expect((await mergedHistoryFixture()).infos.filter((t) => /error/.test(t)).length).toBe(1);
  });

  it("窗口内合并不产生新通知", async () => {
    const f = await mergedHistoryFixture();
    // 清空 info 计数
    f.infos.length = 0;
    // 第二条错误（窗口内）：合并
    f.error({ agent: { id: "mh-1" }, turn: 1, error: new Error("second") });
    expect(f.infos.filter((t) => /error/.test(t)).length).toBe(0);
  });

  it("合并被吞的错误落 suppressed:merged 历史", async () => {
    const f = await mergedHistoryFixture();
    f.error({ agent: { id: "mh-1" }, turn: 1, error: new Error("second") });
    const hist = await waitForHistory(f.historyRoute, (r) => r.some((e) => e.kind === "error" && e.suppressed === "merged"));
    expect(hist.some((e) => e.kind === "error" && e.suppressed === "merged")).toBeTruthy();
  });
});

// ── 12. 多个错误持续到达时窗口不无限顺延（免打扰拦截不开窗 → 每次独立落 quiet 历史） ──
describe("多个错误持续到达时窗口不无限顺延", () => {
  let infos: string[];

  beforeAll(async () => {
    // 动态窗口：写死 "00:00"/"23:59" 在半开区间镜下 23:59 这一分钟不命中
    // （UTC 边缘必炸，run 33282203798 根因）；围绕当前时间 ±2 分钟恒命中。
    infos = [];
    const { listeners } = await makeNotifier(work, { errorMergeWindowMs: 60000, quietHours: { ...quietWindowNow(), allowKinds: [] }, historyFile: join(work, "no-extend-hist.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const error = listeners.get("agent/error")[0];
    // 持续发送多条错误（免打扰拦截，不消耗窗口）
    error({ agent: { id: "ne-1" }, turn: 1, error: new Error("e1") });
    error({ agent: { id: "ne-1" }, turn: 1, error: new Error("e2") });
    error({ agent: { id: "ne-1" }, turn: 1, error: new Error("e3") });
  });

  it("免打扰拦截时多条错误都不产生实际通知", () => {
    // 每条都被免打扰拦截，不产生实际通知
    expect(infos.filter((t) => /error/.test(t) && !t.includes("被免打扰拦截")).length).toBe(0);
  });

  it("每条错误都记录被拦截日志（窗口不无限顺延导致丢失）", () => {
    expect(infos.filter((t) => t.includes("被免打扰拦截")).length).toBe(3);
  });
});

// ── 13. DSH_HOME 感知：apply 默认路径（不传覆盖）读写面落隔离 home ──
/**
 * 隔离 DSH_HOME 夹具：不传 historyFile/statusFile 覆盖（显式 undefined 抹掉
 * makeNotifier 默认），走 config.ts 默认路径解析——应全部落 DSH_HOME。
 */
async function withIsoHome<T>(fn: (f: any) => Promise<T> | T): Promise<T> {
  const isoHome = mkdtempSync(join(tmpdir(), "dnotify-e2e-dsh-home-"));
  const prevDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = isoHome;
  try {
    const infos = [];
    const { listeners, routes, dispose } = await makeNotifier(isoHome, { doneMergeWindowMs: 0, historyFile: undefined, statusFile: undefined, configFile: undefined }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const statusListener = listeners.get("agent/status")[0];
    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    try {
      return await fn({ isoHome, infos, statusListener, historyRoute, dispose });
    } finally {
      dispose();
    }
  } finally {
    if (prevDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevDshHome;
    rmSync(isoHome, { recursive: true, force: true });
  }
}

/** 触发一条完成通知（running → idle 两态）。 */
function fireDone(statusListener, id = "dsh-home-1", title = "隔离home完成") {
  const pair = turnPair(id, title, {}, { turn: 1 });
  statusListener({ agent: pair.running, status: "running" });
  statusListener({ agent: pair.idle, status: "idle" });
}

describe("DSH_HOME 感知：apply 默认路径读写面落隔离 home", () => {
  it("#510：隔离 home 下默认路径历史为空（读面不串真实 ~/.dsh）", async () => {
    await withIsoHome(async ({ historyRoute }) => {
      // 显式读一次而非恒真谓词轮询：JSON.parse 失败即红，对 handler 损坏敏感。
      const { rec: emptyRec, res: emptyRes } = makeRes();
      await historyRoute.handler(fakeReq({}), emptyRes);
      const emptyRecords = JSON.parse(emptyRec.text).records || [];
      expect(emptyRecords).toEqual([]);
    });
  });

  it("#510：完成通知正常发出", async () => {
    await withIsoHome(async ({ infos, statusListener }) => {
      fireDone(statusListener);
      expect(infos.some((t) => /done/.test(t))).toBeTruthy();
    });
  });

  it("#510：默认路径完成通知经路由可读（读写同源落隔离 home）", async () => {
    await withIsoHome(async ({ statusListener, historyRoute }) => {
      fireDone(statusListener);
      const records = await waitForHistory(historyRoute, (r) => r.some((e) => e.kind === "done"));
      expect(records.some((e) => e.kind === "done" && !e.suppressed)).toBeTruthy();
    });
  });

  it("#510：历史 jsonl 落 DSH_HOME（写面）", async () => {
    // 文件系统级断言：jsonl 真实落在 isoHome（写面锁定到 DSH_HOME；读写同源，
    // 同一 store 单一 file，故不再对真实 ~/.dsh 做存在性/mtime 探测——测试
    // 自身零触碰真实 home，也不给外部写入留 flake 面）
    await withIsoHome(async ({ isoHome, statusListener, historyRoute }) => {
      fireDone(statusListener);
      await waitForHistory(historyRoute, (r) => r.some((e) => e.kind === "done"));
      expect(existsSync(join(isoHome, "dsh-notifier-history.jsonl"))).toBeTruthy();
    });
  });
});

// ── 14. suppressed 落史（quiet / kind-pending）也脱敏 ──
describe("suppressed:quiet 落史脱敏", () => {
  // 内置 kind：免打扰拦截 → suppressed:quiet 历史，message 为已脱敏文本
  let quietRecord: any;

  beforeAll(async () => {
    const { listeners, routes } = await makeNotifier(work, {
      errorMergeWindowMs: 60000,
      quietHours: { ...quietWindowNow(), allowKinds: [] },
      historyFile: join(work, "n17-quiet-hist.jsonl"),
    }, {
      logger: { warn: () => {}, info: () => {} },
    });
    const error = listeners.get("agent/error")[0];
    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    // 样本避免「占位符落截断窗口」形态：敏感特征短、位于正文中部
    const sensitive = "postgres://admin:s3cret@db.local down 联系 admin@corp.example.com";
    error({ agent: { id: "n17-q1" }, turn: 1, error: new Error(sensitive) });
    const quietHist = await waitForHistory(historyRoute, (r) => r.some((e) => e.kind === "error" && e.suppressed === "quiet"));
    quietRecord = quietHist.find((e) => e.kind === "error" && e.suppressed === "quiet");
  });

  it("免打扰拦截错误落 suppressed:quiet 历史", () => {
    expect(quietRecord).toBeTruthy();
  });

  it("quiet 落史连接串凭据脱敏", () => {
    expect(quietRecord.message.includes("postgres://<redacted>@db.local")).toBeTruthy();
  });

  it("quiet 落史不残留明文凭据", () => {
    expect(!quietRecord.message.includes("s3cret")).toBeTruthy();
  });

  it("quiet 落史邮箱脱敏（<email>）", () => {
    expect(!quietRecord.message.includes("admin@")).toBeTruthy();
  });
});

describe("suppressed:kind-pending 落史脱敏（动态 kind）", () => {
  // 动态 kind（注册未确认）：send 直通 → suppressed:kind-pending 历史也脱敏
  // （动态 kind 判据为 kind-pending，与内置 kind 的 quiet 区分）
  let r: any;
  let pendingRecord: any;

  beforeAll(async () => {
    const { routes: routesDyn, ctx: ctxDyn } = await makeNotifier(work, { historyFile: join(work, "n17-pending-hist.jsonl") }, {
      logger: { warn: () => {}, info: () => {} },
    });
    const dynHistoryRoute = routesDyn.find((x) => x.path === ROUTES.history);
    const dynNotifier = ctxDyn.get("wingsky.notifier", false);
    dynNotifier.registerKind({ id: "x:task", label: "动态任务" });
    const dynBody = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 联系 admin@corp.example.com";
    r = await dynNotifier.send({ source: "e2e", kind: "x:task", severity: "info", body: dynBody });
    const pendingHist = await waitForHistory(dynHistoryRoute, (rec) => rec.some((e) => e.suppressed === "kind-pending"));
    pendingRecord = pendingHist.find((e) => e.suppressed === "kind-pending");
  });

  it("未确认动态 kind 受理 skipped(kind-pending)", () => {
    expect(r.some((x) => x.status === "skipped" && x.error === "kind-pending")).toBeTruthy();
  });

  it("动态 kind suppressed:kind-pending 落史", () => {
    expect(pendingRecord).toBeTruthy();
  });

  it("kind-pending 落史令牌脱敏", () => {
    expect(pendingRecord.message.includes("<token>")).toBeTruthy();
  });

  it("kind-pending 落史不残留明文令牌", () => {
    expect(!pendingRecord.message.includes("ghp_")).toBeTruthy();
  });

  it("kind-pending 落史邮箱脱敏", () => {
    expect(!pendingRecord.message.includes("admin@")).toBeTruthy();
  });
});

describe("suppressed:merged 落史脱敏（事件层直接 appendHistory）", () => {
  let mergedHist: any[];

  beforeAll(async () => {
    const { listeners: listenersM, routes: routesM } = await makeNotifier(work, {
      errorMergeWindowMs: 60000,
      historyFile: join(work, "n17-merged-hist.jsonl"),
    }, {
      logger: { warn: () => {}, info: () => {} },
    });
    const errorM = listenersM.get("agent/error")[0];
    const historyRouteM = routesM.find((r) => r.path === ROUTES.history);
    // 首条开窗投递（渲染路径落史），第二条窗口内合并（merged 落史）
    errorM({ agent: { id: "n17-m1" }, turn: 1, error: new Error("首条 postgres://admin:s3cret@db.local") });
    errorM({ agent: { id: "n17-m1" }, turn: 1, error: new Error("次条 联系 admin@corp.example.com") });
    mergedHist = await waitForHistory(historyRouteM, (rec) => rec.some((e) => e.suppressed === "merged"));
  });

  it("merged 场景全部 error 落史不残留 DSN 明文", () => {
    for (const rec of mergedHist.filter((e) => e.kind === "error")) {
      expect(!rec.message.includes("s3cret")).toBeTruthy();
    }
  });

  it("merged 场景全部 error 落史不残留邮箱明文", () => {
    for (const rec of mergedHist.filter((e) => e.kind === "error")) {
      expect(!rec.message.includes("admin@")).toBeTruthy();
    }
  });

  it("窗口内合并落 suppressed:merged 历史", () => {
    expect(mergedHist.find((e) => e.kind === "error" && e.suppressed === "merged")).toBeTruthy();
  });

  it("merged 摘要保留「（合并）+摘要」语义（P1-3）", () => {
    const merged = mergedHist.find((e) => e.kind === "error" && e.suppressed === "merged");
    expect(merged.message.startsWith("（合并）")).toBeTruthy();
  });

  it("merged 摘要为打码形态", () => {
    const merged = mergedHist.find((e) => e.kind === "error" && e.suppressed === "merged");
    expect(merged.message.includes("<email>")).toBeTruthy();
  });
});

// ── 15. sanitizeContent 开关链路——默认 true 脱敏 / false 明文 ──
describe("sanitizeContent 默认 true：事件层与 send 直通均脱敏", () => {
  let errInfo: string;
  let dynInfo: string;
  let trueHist: any[];

  beforeAll(async () => {
    // 默认 true（两入口：事件层 error + send 动态 kind 直通）
    const infos = [];
    const { listeners, routes, ctx } = await makeNotifier(work, {
      allowKinds: ["y:task"],
      errorMergeWindowMs: 0,
      historyFile: join(work, "n20-true-hist.jsonl"),
    }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const error = listeners.get("agent/error")[0];
    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const notifier = ctx.get("wingsky.notifier", false);
    notifier.registerKind({ id: "y:task", label: "开关链路" });

    // 入口一：事件层 error → 渲染后统一脱敏
    error({ agent: { id: "n20-1" }, turn: 1, error: new Error("连接 postgres://admin:s3cret@db.local 失败") });
    errInfo = infos.filter((t) => /error/.test(t) && !t.includes("被免打扰拦截"))[0];
    // 入口二：send 动态 kind 直通 → 中心兜底脱敏
    const dynBody = "任务 token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 end";
    await notifier.send({ source: "e2e", kind: "y:task", severity: "info", body: dynBody });
    dynInfo = infos.filter((t) => /y:task/.test(t))[0];
    trueHist = await waitForHistory(historyRoute, (rec) => rec.some((e) => e.kind === "y:task" && !e.suppressed));
  });

  it("默认 true：事件层 error 通知脱敏", () => {
    expect(errInfo.includes("postgres://<redacted>@db.local")).toBeTruthy();
  });

  it("默认 true：事件层 error 不残留明文凭据", () => {
    expect(!errInfo.includes("s3cret")).toBeTruthy();
  });

  it("默认 true：send 动态 kind 通知脱敏", () => {
    expect(dynInfo.includes("<token>")).toBeTruthy();
  });

  it("默认 true：send 动态 kind 不残留明文令牌", () => {
    expect(!dynInfo.includes("ghp_")).toBeTruthy();
  });

  it("默认 true：动态 kind 历史脱敏", () => {
    expect(!trueHist.find((e) => e.kind === "y:task")!.message.includes("ghp_")).toBeTruthy();
  });
});

describe("sanitizeContent=false：通知与历史均明文", () => {
  let errInfo2: string;
  let dynInfo2: string;
  let falseHist: any[];

  beforeAll(async () => {
    // false：通知与历史均明文
    const infos2 = [];
    const { listeners: listeners2, routes: routes2, ctx: ctx2 } = await makeNotifier(work, {
      sanitizeContent: false,
      allowKinds: ["y:task"],
      errorMergeWindowMs: 0,
      historyFile: join(work, "n20-false-hist.jsonl"),
    }, {
      logger: { warn: () => {}, info: (t) => infos2.push(t) },
    });
    const error2 = listeners2.get("agent/error")[0];
    const historyRoute2 = routes2.find((r) => r.path === ROUTES.history);
    const notifier2 = ctx2.get("wingsky.notifier", false);
    notifier2.registerKind({ id: "y:task", label: "开关链路" });

    error2({ agent: { id: "n20-2" }, turn: 1, error: new Error("错误 password=s3cr3t 明文可见") });
    errInfo2 = infos2.filter((t) => /error/.test(t) && !t.includes("被免打扰拦截"))[0];
    const dynBody2 = "任务 联系 admin@corp.example.com 明文可见";
    await notifier2.send({ source: "e2e", kind: "y:task", severity: "info", body: dynBody2 });
    dynInfo2 = infos2.filter((t) => /y:task/.test(t))[0];
    falseHist = await waitForHistory(historyRoute2, (rec) => rec.some((e) => e.kind === "y:task" && !e.suppressed));
  });

  it("false：事件层 error 通知明文", () => {
    expect(errInfo2.includes("password=s3cr3t")).toBeTruthy();
  });

  it("false：send 动态 kind 通知明文", () => {
    expect(dynInfo2.includes("admin@corp.example.com")).toBeTruthy();
  });

  it("false：动态 kind 历史明文", () => {
    expect(falseHist.find((e) => e.kind === "y:task")!.message.includes("admin@corp.example.com")).toBeTruthy();
  });
});
