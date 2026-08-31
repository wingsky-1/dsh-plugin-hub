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
import { assert, makeNotifier, makeFakeCtx, agentWithTitle, makeRes, fakeReq, waitForHistory, turnPair, quietWindowNow } from "./helpers.ts";
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
    await apply(ctx, { enabled: true, toastScript: join(work, "lifecycle-toast.ps1"), historyFile: join(work, "lifecycle-history.jsonl") });
    assert.equal(routeDispCalled.size, 7, "7 条路由注册（M2 增 status/kinds）");
    // 调用所有 effect disposer（清理顺序）
    for (const disp of effectDisposers) disp();
    // 路由 disposer 被触发（从 set 移除）
    assert.equal(routeDispCalled.size, 0, "清理后路由 disposer 全部调用");
    // 监听器 disposer 被触发（闭包/清理 disposers 执行的 for loop）
    assert.ok(listenerDispCalled.size >= 5, "清理后监听器 disposer 全部调用：" + listenerDispCalled.size);
  }

  // ── 2. readBody async-iterator 分支（config PUT 走 web streams）──
  {
    const { routes } = await makeNotifier(work, { historyFile: join(work, "async-iter-hist.jsonl") });
    const configRoute = routes.find((r) => r.path === ROUTES.config);
    // 构造 async-iterable req（有 Symbol.asyncIterator，无 .on）
    const body = JSON.stringify({ patch: { notifyAsk: false } });
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
    assert.equal(JSON.parse(rec.text).user.notifyAsk, false, "async-iterator 分支解析成功");
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
    assert.equal(outcome, "next-result", "notify 抛错后 next 仍转发");
    assert.ok(warns.some((w) => w.includes("通知失败")), "approval notify 失败时 warn 记录");

    // agent/status：idle → notify 抛错 → catch → warn
    const fail2 = turnPair("fail-2", "出错任务", {}, { turn: 1 });
    status({ agent: fail2.running, status: "running" });
    status({ agent: fail2.idle, status: "idle" });
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
    const { listeners } = await makeNotifier(work, { doneMergeWindowMs: 500, notifySubagentDone: true, historyFile: join(work, "merge-kind-hist.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const status = listeners.get("agent/status")[0];
    // 主任务完成 → done 通知，doneBatch 开始
    const mk1 = turnPair("mk-1", "主任务", {}, { turn: 1 });
    status({ agent: mk1.running, status: "running" });
    status({ agent: mk1.idle, status: "idle" });
    assert.equal(infos.filter((t) => /done/.test(t)).length, 1, "首条 done 即时通知");
    // 子代理完成 → kind 不同 → flushDoneMerge（count=1 不补发）+ 即时 subagent-done
    const mk2 = turnPair("mk-2", "子代理", { subagent: true }, { turn: 1 });
    status({ agent: mk2.running, status: "running" });
    status({ agent: mk2.idle, status: "idle" });
    const doneCount = infos.filter((t) => /: done /.test(t)).length;
    const subCount = infos.filter((t) => /: subagent-done /.test(t)).length;
    assert.equal(doneCount, 1, "类型切换后 done 不重复");
    assert.equal(subCount, 1, "子代理完成即时通知（subagent-done）");
  }

  // ── 6. error 合并窗口 ≥3 条 shift（lastMessages 收尾 2 条）──
  {
    const infos = [];
    const { listeners } = await makeNotifier(work, { errorMergeWindowMs: 1000, historyFile: join(work, "merge-shift-hist.jsonl") }, {
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
    const { listeners } = await makeNotifier(work, { notifyTurnEnd: true, historyFile: join(work, "disp-turn-hist.jsonl") }, {
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
    const { listeners } = await makeNotifier(work, { historyFile: join(work, "hook-fail-hist.jsonl") }, {
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
    const { listeners } = await makeNotifier(work, { historyFile: join(work, "noop-idle-hist.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const status = listeners.get("agent/status")[0];
    status({ agent: agentWithTitle("noop-1", "从未 running"), status: "idle" });
    assert.equal(infos.length, 0, "无 running 记录的 idle 不通知");
  }
// ── 10. 免打扰拦截 + 勾选 error 豁免 → 窗口内再报错必须通知 ──
  {
    // #181 动态窗口：写死 "00:00"/"23:59" 在半开区间镜下 23:59 这一分钟不命中
    // （UTC 边缘必炸，run 33282203798 根因）；围绕当前时间 ±2 分钟恒命中。
    const qhAll = quietWindowNow();
    // 免打扰开启，allowKinds 不含 error
    const infos = [];
    const { listeners, routes } = await makeNotifier(work, { errorMergeWindowMs: 60000, quietHours: { ...qhAll, allowKinds: ["ask"] }, historyFile: join(work, "qh-error-hist-1.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const error = listeners.get("agent/error")[0];
    const configRoute = routes.find((r) => r.path === ROUTES.config);
    const historyRoute = routes.find((r) => r.path === ROUTES.history);

    // 第一条错误：免打扰拦截，errorMerge 不开窗
    error({ agent: { id: "qh-e1" }, turn: 1, error: new Error("err1") });
    // 验证被免打扰拦截，且仅一条日志（无实际通知）
    assert.equal(infos.filter((t) => /error/.test(t) && !t.includes("被免打扰拦截")).length, 0, "免打扰拦截时不发实际通知");
    assert.ok(infos.some((t) => t.includes("被免打扰拦截")), "被拦截记录日志");
    // 验证历史中有 suppressed: "quiet"
    const hist1 = await waitForHistory(historyRoute, (r) => r.some((e) => e.kind === "error" && e.suppressed === "quiet"));
    assert.ok(hist1.some((e) => e.kind === "error" && e.suppressed === "quiet"), "被拦截的错误落 suppressed:quiet 历史");

    // 保存配置，开启 error 豁免（通过 PUT /config 模拟面板操作；issue #76 新契约 {patch}）
    const { rec: putRec, res: putRes } = makeRes();
    const newBody = Buffer.from(JSON.stringify({ patch: { quietHours: { ...qhAll, allowKinds: ["ask", "error"] } } }));
    await configRoute.handler({
      method: "PUT",
      url: "/",
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:3080", "content-type": "application/json" },
      on: (evt, cb) => { if (evt === "data") cb(newBody); if (evt === "end") cb(); },
    }, putRes);
    assert.equal(putRec.status, 200, "PUT /config 返回 200");
    // 重置 info 计数
    infos.length = 0;

    // 第二条错误：窗口内（距上一条 < 60s），但无窗口（上一条被拦截未开窗），应正常通知
    error({ agent: { id: "qh-e1" }, turn: 1, error: new Error("err2") });
    assert.equal(infos.filter((t) => /error/.test(t) && !t.includes("被免打扰拦截")).length, 1, "开启 error 豁免后错误正常通知");
    assert.ok(infos.some((t) => /error/.test(t) && t.includes("err2")), "通知内容包含 err2");
  }

  // ── 11. 合并被吞的错误落 suppressed: "merged" 历史 ──
  {
    const infos = [];
    const { listeners, routes } = await makeNotifier(work, { errorMergeWindowMs: 60000, historyFile: join(work, "merged-hist.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const error = listeners.get("agent/error")[0];
    const historyRoute = routes.find((r) => r.path === ROUTES.history);

    // 第一条错误：开窗
    error({ agent: { id: "mh-1" }, turn: 1, error: new Error("first") });
    assert.equal(infos.filter((t) => /error/.test(t)).length, 1, "首条错误通知");
    // 清空 info 计数
    infos.length = 0;

    // 第二条错误（窗口内）：合并，应落 suppressed: "merged" 历史
    error({ agent: { id: "mh-1" }, turn: 1, error: new Error("second") });
    assert.equal(infos.filter((t) => /error/.test(t)).length, 0, "窗口内合并不产生新通知");
    // 验证历史中有 suppressed: "merged"
    const hist = await waitForHistory(historyRoute, (r) => r.some((e) => e.kind === "error" && e.suppressed === "merged"));
    assert.ok(hist.some((e) => e.kind === "error" && e.suppressed === "merged"), "合并被吞的错误落 suppressed:merged 历史");
  }

  // ── 12. 多个错误持续到达时窗口不无限顺延（免打扰拦截不开窗 → 每次独立落 quiet 历史） ──
  {
    // #181 动态窗口：写死 "00:00"/"23:59" 在半开区间镜下 23:59 这一分钟不命中
    // （UTC 边缘必炸，run 33282203798 根因）；围绕当前时间 ±2 分钟恒命中。
    const qhAll = quietWindowNow();
    const infos = [];
    const { listeners } = await makeNotifier(work, {  errorMergeWindowMs: 60000, quietHours: { ...qhAll, allowKinds: [] } , historyFile: join(work, "no-extend-hist.jsonl") }, {
      logger: { warn: () => {}, info: (t) => infos.push(t) },
    });
    const error = listeners.get("agent/error")[0];

    // 持续发送多条错误（免打扰拦截，不消耗窗口）
    error({ agent: { id: "ne-1" }, turn: 1, error: new Error("e1") });
    error({ agent: { id: "ne-1" }, turn: 1, error: new Error("e2") });
    error({ agent: { id: "ne-1" }, turn: 1, error: new Error("e3") });
    // 每条都被免打扰拦截，不产生实际通知
    const actualNotifies = infos.filter((t) => /error/.test(t) && !t.includes("被免打扰拦截"));
    assert.equal(actualNotifies.length, 0, "免打扰拦截时多条错误都不产生实际通知");
    // 每条都记录了被拦截日志
    const suppressedLogs = infos.filter((t) => t.includes("被免打扰拦截"));
    assert.equal(suppressedLogs.length, 3, "每条错误都记录被拦截日志（窗口不无限顺延导致丢失）");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}