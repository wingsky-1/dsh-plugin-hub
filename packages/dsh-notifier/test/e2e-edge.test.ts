// @ts-nocheck
/**
 * dsh-notifier — e2e：边缘路径与清理生命周期（#82 批次 4 热点补强）。
 *
 * 覆盖：生命周期 disposer 清理、readBody async-iterator 分支、审批超时提醒、
 * 通知失败容错（catch 不崩）、完成聚合类型切换、错误合并 ≥3 条 shift、
 * disposed 清理 turn 去重、hookUserQuestions 服务缺失/抛错容错、
 * 无状态 idle 不误报。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assert, makeNotifier, makeFakeCtx, agentWithTitle, makeRes, fakeReq } from "./helpers.ts";
import { ROUTES, apply } from "../lib/index.js";

const work = mkdtempSync(join(tmpdir(), "dnotify-e2e-edge-"));
try {
  // ── 1. 生命周期清理：ctx.effect disposer 触发后，路由/监听器 disposer 被调用 ──
  {
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
    await apply(ctx, { enabled: true, configFile: join(work, "lifecycle-cfg.json"), toastScript: join(work, "lifecycle-toast.ps1"), historyFile: join(work, "lifecycle-history.jsonl") });
    assert.equal(routeDispCalled.size, 5, "5 条路由注册");
    // 调用所有 effect disposer（清理顺序）
    for (const disp of effectDisposers) disp();
    // 路由 disposer 被触发（从 set 移除）
    assert.equal(routeDispCalled.size, 0, "清理后路由 disposer 全部调用");
    // 监听器 disposer 被触发（闭包/清理 disposers 执行的 for loop）
    assert.ok(listenerDispCalled.size >= 5, "清理后监听器 disposer 全部调用：" + listenerDispCalled.size);
  }

  // ── 2. readBody async-iterator 分支（config PUT 走 web streams）──
  {
    const { routes } = await makeNotifier(work, { configFile: join(work, "async-iter-cfg.json"), historyFile: join(work, "async-iter-hist.jsonl") });
    const configRoute = routes.find((r) => r.path === ROUTES.config);
    // 构造 async-iterable req（有 Symbol.asyncIterator，无 .on）
    const body = JSON.stringify({ notifyAsk: false });
    const chunks = [Buffer.from(body)];
    let idx = 0;
    const asyncIterReq = {
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
    // 确保没有 .on 方法（触发 async-iterator 分支）
    assert.equal(typeof asyncIterReq.on, "undefined", "async-iter req 无 .on 方法");
    const { rec, res } = makeRes();
    await configRoute.handler(asyncIterReq, res);
    assert.equal(rec.status, 200);
    assert.equal(JSON.parse(rec.text).notifyAsk, false, "async-iterator 分支解析成功");
  }

  // ── 3. 审批超时提醒（askRemindMin > 0 分支）──
  {
    const capturedTimers = [];
    const origSet = globalThis.setTimeout;
    // 透明代理：记录 setTimeout 调用，但仍转发到真实实现
    globalThis.setTimeout = (cb, ms, ...args) => {
      const timer = origSet(cb, ms, ...args);
      capturedTimers.push({ ms, timer });
      return timer;
    };
    try {
      writeFileSync(join(work, "ask-remind-cfg.json"), JSON.stringify({ askRemindMin: 1 }));
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: join(work, "ask-remind-cfg.json"), historyFile: join(work, "ask-remind-hist.jsonl") }, {
        logger: { warn: (m) => { infos.push(`warn: ${m}`); }, info: (t) => infos.push(t) },
      });
      // 清理 apply 阶段的 timer 记录（execFile timeout 等）
      capturedTimers.length = 0;
      const approval = listeners.get("approval/request")[0];
      const askReq = { toolName: "pwsh", agent: agentWithTitle("remind-1", "超时审批测试"), reason: "test" };
      const nextPromise = approval(askReq, async () => "reminded");
      const askTimer = capturedTimers.find((t) => t.ms === 60000);
      assert.ok(askTimer, "askRemindMin > 0 注册了 60000ms 定时器");
      const outcome = await nextPromise;
      assert.equal(outcome, "reminded", "next 结果透传");
    } finally {
      globalThis.setTimeout = origSet;
    }
  }

  // ── 4. 通知失败容错：notify 抛错时 handler 不崩，catch → warn → 仍继续后续逻辑 ──
  {
    const warns = [];
    // 启用 notifyTurnEnd 以使 turn-stopping 进入通知路径（默认关）
    writeFileSync(join(work, "fail-cfg.json"), JSON.stringify({ notifyTurnEnd: true }));
    const { listeners } = await makeNotifier(work, { configFile: join(work, "fail-cfg.json"), historyFile: join(work, "fail-hist.jsonl") }, {
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
    assert.equal(outcome, "next-result", "notify 抛错后 next 仍转发");
    assert.ok(warns.some((w) => w.includes("通知失败")), "approval notify 失败时 warn 记录");

    // agent/status：idle → notify 抛错 → catch → warn
    status({ agent: agentWithTitle("fail-2", "出错任务", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("fail-2", "出错任务", { turnEnd: 1 }), status: "idle" });
    assert.ok(warns.some((w) => w.includes("agent/status")), "status notify 失败时 warn 记录");

    // agent/error：notify 抛错 → catch → warn
    error({ agent: { id: "fail-3" }, turn: 1, error: new Error("test error") });
    assert.ok(warns.some((w) => w.includes("agent/error")), "error notify 失败时 warn 记录");

    // turn-stopping：notify 抛错 → catch → warn
    await turnStop({ agent: { id: "fail-4" }, turn: 1 });
    assert.ok(warns.some((w) => w.includes("turn-stopping")), "turn-stopping notify 失败时 warn 记录");
  }

  // ── 5. 完成聚合类型切换（done → subagent-done 混合）──
  {
    const infos = [];
    writeFileSync(join(work, "merge-kind-cfg.json"), JSON.stringify({ doneMergeWindowMs: 500, notifySubagentDone: true }));
    const { listeners } = await makeNotifier(work, { configFile: join(work, "merge-kind-cfg.json"), historyFile: join(work, "merge-kind-hist.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const status = listeners.get("agent/status")[0];
    // 主任务完成 → done 通知，doneBatch 开始
    status({ agent: agentWithTitle("mk-1", "主任务", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("mk-1", "主任务", { turnEnd: 1 }), status: "idle" });
    assert.equal(infos.filter((t) => /done/.test(t)).length, 1, "首条 done 即时通知");
    // 子代理完成 → kind 不同 → flushDoneMerge（count=1 不补发）+ 即时 subagent-done
    status({ agent: agentWithTitle("mk-2", "子代理", { subagent: true, turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("mk-2", "子代理", { subagent: true, turnEnd: 1 }), status: "idle" });
    const doneCount = infos.filter((t) => /: done /.test(t)).length;
    const subCount = infos.filter((t) => /: subagent-done /.test(t)).length;
    assert.equal(doneCount, 1, "类型切换后 done 不重复");
    assert.equal(subCount, 1, "子代理完成即时通知（subagent-done）");
  }

  // ── 6. error 合并窗口 ≥3 条 shift（lastMessages 收尾 2 条）──
  {
    const infos = [];
    writeFileSync(join(work, "merge-shift-cfg.json"), JSON.stringify({ errorMergeWindowMs: 1000 }));
    const { listeners } = await makeNotifier(work, { configFile: join(work, "merge-shift-cfg.json"), historyFile: join(work, "merge-shift-hist.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const error = listeners.get("agent/error")[0];
    // 4 条错误在同一个窗口
    error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e1") });
    error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e2") });
    error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e3") });
    error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e4") });
    assert.equal(infos.filter((t) => /error/.test(t)).length, 1, "4 条错误只通知 1 条（窗口内合并）");
    await new Promise((resolve) => setTimeout(resolve, 1100)); // 等窗口过期
    error({ agent: { id: "shift-1" }, turn: 1, error: new Error("e5") });
    // 窗口过期后通知应携带 mergedCount=3（e2-4 被合并）+ mergedErrors 为 [e3, e4]（shift 后收尾 2 条）
    const mergedInfo = infos.filter((t) => /error/.test(t) && t.includes("同类错误"))[0];
    assert.ok(mergedInfo?.includes("另有 3 条同类错误"), "窗口过期后通知携带合并计数 3");
    assert.ok(mergedInfo?.includes("e3"), "shift 后 e3 保留在 mergedErrors");
    assert.ok(mergedInfo?.includes("e4"), "shift 后 e4 保留在 mergedErrors");
    assert.ok(!mergedInfo?.includes("e2"), "e2 被 shift 移出 mergedErrors");
  }

  // ── 7. agent/disposed 清理 turnNotified 前缀 ──
  {
    const infos = [];
    writeFileSync(join(work, "disp-turn-cfg.json"), JSON.stringify({ notifyTurnEnd: true }));
    const { listeners } = await makeNotifier(work, { configFile: join(work, "disp-turn-cfg.json"), historyFile: join(work, "disp-turn-hist.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const turnStop = listeners.get("agent/turn-stopping")[0];
    const disposed = listeners.get("agent/disposed")[0];
    await turnStop({ agent: { id: "disp-1" }, turn: 1 });
    let turnCount = infos.filter((t) => /turn-end/.test(t)).length;
    assert.equal(turnCount, 1, "首轮 turn-stopping 通知");
    // 同轮重复 → 不通知（去重生效）
    await turnStop({ agent: { id: "disp-1" }, turn: 1 });
    assert.equal(infos.filter((t) => /turn-end/.test(t)).length, 1, "去重生效");
    // disposed 清理后 → 再次通知（去重条目被清除）
    disposed({ agent: { id: "disp-1" } });
    await turnStop({ agent: { id: "disp-1" }, turn: 1 });
    assert.equal(infos.filter((t) => /turn-end/.test(t)).length, 2, "disposed 清理后重发通知");
    // agent.id 为 undefined → 不抛
    disposed({ agent: {} });
    disposed({ agent: {} });
    assert.ok(true, "agent.id 为 undefined 时不抛");
  }

  // ── 8. hookUserQuestions：ctx.get 抛出 → 静默容错 ──
  {
    const { listeners } = await makeNotifier(work, { configFile: join(work, "hook-fail-cfg.json"), historyFile: join(work, "hook-fail-hist.jsonl") }, {
      get: () => { throw new Error("service not ready"); },
      logger: { warn: () => {}, info: () => {} },
    });
    // apply 不应抛异常
    assert.ok(!!listeners.get("internal/service")[0], "apply 成功，internal/service 监听器已注册");
    // internal/service 事件触发 hookUserQuestions → 同样静默
    const svcHandler = listeners.get("internal/service")[0];
    svcHandler("userQuestions", undefined);
    assert.ok(true, "internal/service 触发时 ctx.get 抛错不崩");
  }

  // ── 9. 无状态 idle：无 running 记录时 idle 不误报 ──
  {
    const infos = [];
    const { listeners } = await makeNotifier(work, { configFile: join(work, "noop-idle-cfg.json"), historyFile: join(work, "noop-idle-hist.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const status = listeners.get("agent/status")[0];
    status({ agent: agentWithTitle("noop-1", "从未 running"), status: "idle" });
    assert.equal(infos.length, 0, "无 running 记录的 idle 不通知");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}