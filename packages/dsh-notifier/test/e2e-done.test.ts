// @ts-nocheck
/**
 * dsh-notifier — e2e：任务完成状态机 / 错误通知与合并 / 子代理分流。
 *
 * 覆盖：agent/status per-agent 状态机（多会话互不误报、连续 idle 不重复、
 * disposed 清理）；完成风暴聚合（首条即时 + 窗口补发聚合条）；agent/error
 * 通知与滚动窗口合并（含窗口过期计数、0=关闭）；子代理完成场景（issue #49：
 * fork 型委派按运行时归属拆分——归属成立默认静默/开关联动 subagent-done、
 * 归属不成立保护用户 fork 主线走 done；spawn 型 origin 用例与 S2 开关组合）；
 * issue #290 阶段二单源收敛（session/event push 为主证据 + lastTurnEndOf
 * 快照仅 push 缺失兜底 + runningBaseline 冻结 abort-early 陈旧快照）与
 * 跳过路径 warn（证据源字段）；D-1/D-2 重载窗口后首轮 live turn 仍通知、
 * 重载不引入假阳性。
 *
 * 时序约定（helpers.turnPair / agentWithTitle 联用）：所有「本轮完成」用例
 * 必须区分 running/idle 两态事件面——running 态 events 为上一轮 closure
 * （或空），idle 态为本轮 closure（见 helpers.turnPair 注释）；「running 与
 * idle 同构造（idle 无推进）」即 abort-early 无新 closure 形态，必须静默。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assert, makeNotifier, agentWithTitle, fakeAgents, waitMergeWindow, fakeReq, makeRes, turnEndEvent, waitForHistory, turnPair } from "./helpers.ts";
import { ROUTES, lastTurnEndOf } from "../lib/index.js";

/** 带 info 收集的 logger 覆盖。 */
function loggingOverride(infos) {
  return { logger: { warn: () => {}, info: (t) => infos.push(t) } };
}

const work = mkdtempSync(join(tmpdir(), "dnotify-e2e-done-"));
try {
  // per-agent 状态机 + 错误通知/合并 + 完成风暴聚合（同一实例）
  {
    const infos = [];
    const { listeners } = await makeNotifier(work, {}, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const disposed = listeners.get("agent/disposed")[0];
    const error = listeners.get("agent/error")[0];

    // agent/status：per-agent 状态机，多会话互不误报（真实宿主跑完一轮必有 turn/end，故 idle 断言带 turnEnd）
    status({ agent: agentWithTitle("session-1", "优化 notifier 插件"), status: "running" });
    status({ agent: agentWithTitle("session-2", "并行评审代码"), status: "running" });
    assert.equal(infos.length, 0, "running 不通知");
    status({ agent: agentWithTitle("session-2", "并行评审代码", { turnEnd: 1 }), status: "idle" });
    assert.equal(infos.length, 1, "session-2 完成通知一次");
    assert.match(infos[0], /done/);
    assert.match(infos[0], /任务「并行评审代码」已完成/, "完成通知带任务标题");
    assert.match(infos[0], /耗时：/, "完成通知带耗时");
    assert.ok(!infos[0].includes("session-"), "完成通知不暴露会话 id");
    // 完成风暴聚合窗口（3s）：等上一处完成的窗口结束，保证同 agent 下一轮是独立窗口
    await waitMergeWindow();
    status({ agent: agentWithTitle("session-1", "优化 notifier 插件", { turnEnd: 1 }), status: "idle" });
    assert.equal(infos.length, 2, "session-1 完成独立通知");
    assert.match(infos[1], /任务「优化 notifier 插件」已完成/);
    status({ agent: agentWithTitle("session-1", "优化 notifier 插件"), status: "idle" });
    assert.equal(infos.length, 2, "连续 idle 不重复通知");
    status({ agent: agentWithTitle("session-2", "并行评审代码"), status: "idle" });
    assert.equal(infos.length, 2, "session-2 无 running 记录不通知");

    // agent/disposed：清理状态机，防会话销毁后残留 idle 误报
    status({ agent: agentWithTitle("session-3", "临时会话"), status: "running" });
    disposed({ agent: agentWithTitle("session-3", "临时会话") });
    status({ agent: agentWithTitle("session-3", "临时会话"), status: "idle" });
    assert.equal(infos.length, 2, "disposed 清理后残留 idle 不误报");

    // agent/error：通知（任务标题/轮次步骤/错误信息）；60 秒窗口内同类错误合并
    error({ agent: agentWithTitle("session-1", "优化 notifier 插件"), turn: 1, step: 1, error: new Error("测试错误信息") });
    assert.equal(infos.length, 3);
    assert.match(infos[2], /error/);
    assert.match(infos[2], /任务「优化 notifier 插件」执行出错/, "错误通知带任务标题");
    assert.match(infos[2], /第 1 轮第 1 步：测试错误信息/, "轮次/步骤与错误信息同行");
    assert.ok(!infos[2].includes("session-"), "错误通知不暴露会话 id");
    error({ agent: agentWithTitle("session-1", "优化 notifier 插件"), turn: 1, step: 2, error: new Error("窗口内错误") });
    assert.equal(infos.length, 3, "窗口内同类错误合并，不重复通知");
    error({ agent: agentWithTitle("session-2", "并行评审代码"), turn: 1, step: 3, error: new Error("其他会话错误") });
    assert.equal(infos.length, 4, "不同会话独立合并窗口");
    assert.match(infos[3], /任务「并行评审代码」执行出错/);

    // 完成风暴聚合：窗口内第二条完成不即时，3s 后补发聚合条（防并行收尾刷屏）
    await waitMergeWindow(); // 窗口清零（error/turn 无完成窗口）
    const stormA = turnPair("storm-1", "并行任务A", {}, { turn: 1 });
    status({ agent: stormA.running, status: "running" });
    status({ agent: stormA.idle, status: "idle" });
    assert.equal(infos.length, 5, "聚合窗口首条即时通知");
    const stormB = turnPair("storm-2", "并行任务B", {}, { turn: 1 });
    status({ agent: stormB.running, status: "running" });
    status({ agent: stormB.idle, status: "idle" });
    assert.equal(infos.length, 5, "窗口内第二条挂起不即时发");
    await waitMergeWindow();
    assert.equal(infos.length, 6, "窗口到点补发聚合条");
    assert.match(infos[5], /另有 1 个任务已完成/, "聚合条文案带计数");
    assert.match(infos[5], /并行任务B/, "聚合条带最近标题");
  }

  // 错误合并窗口过期后通知并携带合并计数（独立实例：20ms 窗口）
  {
    const mergeCfg = join(work, "merge-observed.json");
    writeFileSync(mergeCfg, JSON.stringify({ errorMergeWindowMs: 20 }));
    const infos = [];
    const { listeners } = await makeNotifier(work, { configFile: mergeCfg }, loggingOverride(infos));
    const error = listeners.get("agent/error")[0];

    error({ agent: { id: "session-1" }, turn: 1, step: 1, error: new Error("e1") });
    assert.equal(infos.length, 1);
    error({ agent: { id: "session-1" }, turn: 1, step: 2, error: new Error("e2") });
    assert.equal(infos.length, 1, "窗口内合并");
    await new Promise((resolve) => setTimeout(resolve, 30));
    error({ agent: { id: "session-1" }, turn: 1, step: 3, error: new Error("e3") });
    assert.equal(infos.length, 2, "窗口过期后恢复通知");
    assert.match(infos[1], /另有 1 条同类错误/, "窗口过期后的通知携带合并计数");
    assert.match(infos[1], /窗口内其他错误/, "被合并错误保留摘要（e1）");
  }

  // 合并 0=关闭：错误不合并、完成不聚合（每条即时）
  {
    const cfg0 = join(work, "merge-off.json");
    writeFileSync(cfg0, JSON.stringify({ errorMergeWindowMs: 0, doneMergeWindowMs: 0 }));
    const infos = [];
    const { listeners } = await makeNotifier(work, { configFile: cfg0 }, loggingOverride(infos));
    const error = listeners.get("agent/error")[0];
    const status = listeners.get("agent/status")[0];

    // 错误：窗口=0 → 两条都通知（不合并）
    error({ agent: { id: "s0-1" }, turn: 1, step: 1, error: new Error("x1") });
    error({ agent: { id: "s0-1" }, turn: 1, step: 2, error: new Error("x2") });
    assert.equal(infos.length, 2, "errorMergeWindowMs=0：错误不合并");

    // 完成：窗口=0 → 连续两条完成都即时通知（不聚合）
    status({ agent: agentWithTitle("s0-a", "任务甲", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("s0-a", "任务甲", { turnEnd: 2 }), status: "idle" });
    status({ agent: agentWithTitle("s0-b", "任务乙", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("s0-b", "任务乙", { turnEnd: 2 }), status: "idle" });
    const doneCount = infos.filter((t) => /done/.test(t)).length;
    assert.equal(doneCount, 2, "doneMergeWindowMs=0：完成不聚合，两条都即时");
  }

  // 子代理完成：独立开关 notifySubagentDone（默认关）+ 独立事件类型 subagent-done
  {
    const subCfg = join(work, "subagent.json");

    // ── issue #49：fork 型委派子代理完成不再误报主任务 kind=done ──
    // fork 型委派（parentSession + seedLength、无 origin、depth=0）与用户 fork
    // 主线在持久化 header 上不可区分，判定补运行时归属（ctx.agents.get /
    // isOwnedBy）。原反例 1「仅 parentSession 无 origin 必须 walk done」与新
    // 验收冲突，已按归属成立/不成立拆分改写（旧语义不保留）：

    // A1：归属成立（父 live 且 isOwnedBy true）+ notifySubagentDone 默认关 →
    //     该轮完全静默，通知历史无新增任何记录（尤其无 done）。
    {
      const agents = fakeAgents(["main-parent", "fork-worker"], [["fork-worker", "main-parent"]]);
      const infos = [];
      const { listeners, routes } = await makeNotifier(
        work,
        { configFile: join(work, "sub-fork-owned.json"), historyFile: join(work, "history-a1.jsonl") },
        { agents, ...loggingOverride(infos) }
      );
      const status = listeners.get("agent/status")[0];
      // fork 型委派完整持久化 header 形态：parentSession + seedLength、无 origin、depth=0（#199 P2-5 对齐）
      // 本轮完成时序：running 态无 closure（首轮）、idle 态 turn=1 completed（helpers.turnPair）
      const forkPair = () => turnPair("fork-worker", "fork 委派子任务", { parentSession: "main-parent", seedLength: 3, depth: 0 }, { turn: 1 });
      status({ agent: forkPair().running, status: "running" });
      status({ agent: forkPair().idle, status: "idle" });
      assert.equal(infos.length, 0, "A1：fork 型委派归属成立且默认关时完全静默");
      // 通知历史复核（AC 验证入口）：静默路径不触发任何 appendHistory，读全量应为空
      const historyRoute = routes.find((r) => r.path === ROUTES.history);
      const { rec, res } = makeRes();
      await historyRoute.handler(fakeReq({}), res);
      const records = JSON.parse(rec.text).records || [];
      assert.equal(records.length, 0, "A1：通知历史无新增 done 记录");
    }

    // A2：同一场景开启 notifySubagentDone=true → 恰一条 subagent-done（文案含
    //     任务标题与耗时），且不得同时出现 kind=done。
    {
      const onCfg = join(work, "sub-fork-on.json");
      writeFileSync(onCfg, JSON.stringify({ notifySubagentDone: true }));
      const agents = fakeAgents(["main-parent2", "fork-worker2"], [["fork-worker2", "main-parent2"]]);
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: onCfg }, { agents, ...loggingOverride(infos) });
      const status = listeners.get("agent/status")[0];
      // 同 A1：完整持久化 header 形态含 seedLength（#199 P2-5 对齐）+ 本轮完成时序
      const forkPair = () => turnPair("fork-worker2", "fork 委派子任务B", { parentSession: "main-parent2", seedLength: 3, depth: 0 }, { turn: 1 });
      status({ agent: forkPair().running, status: "running" });
      status({ agent: forkPair().idle, status: "idle" });
      assert.equal(infos.length, 1, "A2：开启开关时恰产生一条通知");
      assert.match(infos[0], /subagent-done/, "A2：事件类型为 subagent-done");
      assert.match(infos[0], /子任务「fork 委派子任务B」已完成/, "A2：文案带任务标题");
      assert.match(infos[0], /耗时：/, "A2：文案带耗时");
      assert.ok(!infos.some((t) => /dsh-notifier: done /.test(t)), "A2：不得同时出现 kind=done");
    }

    // B1 支 1：header 含 parentSession 但父 id 不在 live registry（父已销毁/
    // 冷 resume 脱离）→ 归属不成立，必须走主任务分支 kind=done（保护用户
    // fork 主线，#7 语义不回归），不得被静默或误报 subagent-done。
    {
      const agents = fakeAgents(["fork-orphan"], []);
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: join(work, "sub-fork-orphan.json") }, { agents, ...loggingOverride(infos) });
      const status = listeners.get("agent/status")[0];
      const mk = () => turnPair("fork-orphan", "孤儿 fork 会话", { parentSession: "ghost-parent" }, { turn: 1 });
      status({ agent: mk().running, status: "running" });
      status({ agent: mk().idle, status: "idle" });
      assert.equal(infos.length, 1, "B1：父 id 不存在时不被静默");
      assert.match(infos[0], /dsh-notifier: done /, "B1：发 kind=done 而非 subagent-done");
    }

    // B1 支 2：父 id live 但运行时不持有该 agent（isOwnedBy false，如无关
    // provider 复用 id）→ 归属不成立，同样走主任务分支 kind=done。
    {
      const agents = fakeAgents(["unrelated-parent", "fork-x"], []); // 无 (fork-x, unrelated-parent) 归属对
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: join(work, "sub-fork-unowned.json") }, { agents, ...loggingOverride(infos) });
      const status = listeners.get("agent/status")[0];
      const mk = () => turnPair("fork-x", "无归属 fork 会话", { parentSession: "unrelated-parent", seedLength: 3 }, { turn: 1 });
      status({ agent: mk().running, status: "running" });
      status({ agent: mk().idle, status: "idle" });
      assert.equal(infos.length, 1, "B1：isOwnedBy=false 时归属不成立，不被静默");
      assert.match(infos[0], /dsh-notifier: done /, "B1：发 kind=done 而非 subagent-done");
    }

    // D1：headless CLI 会话（header 仅 {cwd}，无 origin 无 parentSession）两信号
    //     皆否，保持现状按主任务分支处理（本 issue 不改变其分类）。
    {
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: join(work, "sub-headless.json") }, loggingOverride(infos));
      const status = listeners.get("agent/status")[0];
      const mk = () => turnPair("headless-1", "headless CLI 会话", { cwd: "/tmp/dsh-cli" }, { turn: 1 });
      status({ agent: mk().running, status: "running" });
      status({ agent: mk().idle, status: "idle" });
      assert.equal(infos.length, 1, "D1：headless 会话保持主任务分支现状");
      assert.match(infos[0], /dsh-notifier: done /);
    }

    // 反例 2（原 #7 回归防护保留）：主会话（无 header / 无 origin）必须走 done。
    {
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: join(work, "sub-main.json") }, loggingOverride(infos));
      const status = listeners.get("agent/status")[0];
      const pair = turnPair("main-x", "主任务", {}, { turn: 1 });
      status({ agent: pair.running, status: "running" });
      status({ agent: pair.idle, status: "idle" });
      assert.equal(infos.length, 1, "主会话完成走 done");
      assert.match(infos[0], /dsh-notifier: done /);
    }

    // 默认关：子代理完成不通知，主任务完成不受影响
    {
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: join(work, "sub-default.json") }, loggingOverride(infos));
      const status = listeners.get("agent/status")[0];
      const subPair = turnPair("sub-1", "子任务A", { subagent: true }, { turn: 1 });
      status({ agent: subPair.running, status: "running" });
      status({ agent: subPair.idle, status: "idle" });
      assert.equal(infos.length, 0, "notifySubagentDone 默认关：子代理完成不通知");
      const mainPair = turnPair("main-1", "主任务", {}, { turn: 1 });
      status({ agent: mainPair.running, status: "running" });
      status({ agent: mainPair.idle, status: "idle" });
      assert.equal(infos.length, 1, "主任务完成不受子代理开关影响");
      assert.match(infos[0], /done/);
    }

    // 开启 notifySubagentDone：子代理完成用独立事件类型 subagent-done（标题/耗时）
    {
      const onCfg = join(work, "sub-on.json");
      writeFileSync(onCfg, JSON.stringify({ notifySubagentDone: true }));
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: onCfg }, loggingOverride(infos));
      const status = listeners.get("agent/status")[0];
      const subPair = turnPair("sub-2", "子任务B", { subagent: true }, { turn: 1 });
      status({ agent: subPair.running, status: "running" });
      status({ agent: subPair.idle, status: "idle" });
      assert.equal(infos.length, 1);
      assert.match(infos[0], /subagent-done/, "子代理完成用独立事件类型");
      assert.match(infos[0], /子任务「子任务B」已完成/, "subagent-done 文案带任务标题");
      assert.match(infos[0], /耗时：/, "subagent-done 带耗时");
      assert.ok(!infos[0].includes("sub-2"), "子代理完成通知不暴露会话 id");
      // 等 subagent-done 的 3s 聚合窗口结束（否则主任务完成会被聚合挂起）
      await waitMergeWindow();
      const mainPair = turnPair("main-2", "主任务2", {}, { turn: 1 });
      status({ agent: mainPair.running, status: "running" });
      status({ agent: mainPair.idle, status: "idle" });
      assert.equal(infos.length, 2, "主任务仍走 done 类型");
      assert.match(infos[1], /done/);
    }

    // S2 回归：notifyTaskDone=false + notifySubagentDone=true 时子代理完成仍通知
    {
      const s2Cfg = join(work, "sub-s2.json");
      writeFileSync(s2Cfg, JSON.stringify({ notifyTaskDone: false, notifySubagentDone: true }));
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: s2Cfg }, loggingOverride(infos));
      const status = listeners.get("agent/status")[0];
      const subPair = turnPair("sub-3", "子任务C", { subagent: true }, { turn: 1 });
      status({ agent: subPair.running, status: "running" });
      status({ agent: subPair.idle, status: "idle" });
      assert.equal(infos.length, 1, "notifyTaskDone=false 不拦截子代理完成（S2）");
      assert.match(infos[0], /subagent-done/);
      const mainPair = turnPair("main-3", "主任务3", {}, { turn: 1 });
      status({ agent: mainPair.running, status: "running" });
      status({ agent: mainPair.idle, status: "idle" });
      assert.equal(infos.length, 1, "notifyTaskDone=false 主任务不通知");
      // 既有 bug 修复回归：notifyTaskDone=false 时 idle 无条件重置状态，
      // 之后重开开关不会把旧的 running 误报为完成
      status({ agent: agentWithTitle("main-3", "主任务3"), status: "running" });
      assert.equal(infos.length, 1, "running 仍不通知");
    }
  }

  // ── issue #290 阶段二：证据面单源收敛（session/event push 主源 + lastTurnEndOf
  //    快照仅 push 缺失兜底 + runningBaseline 冻结）+ 跳过路径 warn 兜底 ──
  {
    const infos = [];
    const warns = [];
    // 关闭完成聚合：本块聚焦单源证据合并语义，每条完成即时通知便于计数
    // （doneMergeWindowMs 是运行时配置，须经 configFile 文件传入）
    const singleCfg = join(work, "single-source.json");
    writeFileSync(singleCfg, JSON.stringify({ doneMergeWindowMs: 0 }));
    const { listeners } = await makeNotifier(
      work,
      { configFile: singleCfg },
      { logger: { info: (t) => infos.push(t), warn: (t) => warns.push(t) } }
    );
    const status = listeners.get("agent/status")[0];
    const sessionEvent = listeners.get("session/event")[0];
    const disposed = listeners.get("agent/disposed")[0];
    const countDone = () => infos.filter((t) => /dsh-notifier: done /.test(t)).length;

    // (a) push 恒定新鲜为主证据（#272 报告场景反证，阶段二 A-2）：agent.session
    //     .events 冻结在 turn=1（快照一次性读滞后被 lastEndedTurn 固化的形态——
    //     running/idle 同构造恰模拟 events 停滞），session/event 推送流正常逐轮
    //     派发。单源收敛后判定只采信 push（不读快照）→ 逐轮通知 4 条，不再
    //     依赖双源按 turn 取新。
    for (let turn = 1; turn <= 4; turn += 1) {
      status({ agent: agentWithTitle("stuck-a", "停滞会话", { turnEnd: 1 }), status: "running" });
      sessionEvent({ id: "stuck-a" }, turnEndEvent(turn));
      status({ agent: agentWithTitle("stuck-a", "停滞会话", { turnEnd: 1 }), status: "idle" });
    }
    assert.equal(countDone(), 4, "(a) events 停滞形态下 push 主证据逐轮通知（快照冻结不影响）");

    // (b) 同 turn 去重（A-3）：push 与快照指向同一 append-only 日志的同一事件，
    //     turn 相同即同一证据——采信 push 后合并为单次通知；已记忆 turn 的重复
    //     派发不重复通知。
    status({ agent: agentWithTitle("dedup-1", "去重会话", { turnEnd: 2 }), status: "running" });
    sessionEvent({ id: "dedup-1" }, turnEndEvent(2));
    status({ agent: agentWithTitle("dedup-1", "去重会话", { turnEnd: 2 }), status: "idle" });
    assert.equal(countDone(), 5, "(b) push+快照同 turn 合并为单次通知");
    sessionEvent({ id: "dedup-1" }, turnEndEvent(2)); // 已记忆 turn 的重复派发不再触发
    status({ agent: agentWithTitle("dedup-1", "去重会话", { turnEnd: 2 }), status: "running" });
    status({ agent: agentWithTitle("dedup-1", "去重会话", { turnEnd: 2 }), status: "idle" });
    assert.equal(countDone(), 5, "(b) 已记忆 turn 的重复到达不重复通知");

    // (c) 跳过路径 warn 兜底（E-1）：无新证据的 idle 判定跳过必须可观测，且
    //     warn 字段标识证据来源（单源语义：证据源=push / 快照兜底 / 快照冻结）。
    //     首轮为真实完成时序（running 无 closure → idle turn=1 completed 通知），
    //     第二轮 events 仍停 turn=1（abort-early 形态）→ 快照 ≤ running 基线
    //     被冻结 → 跳过 + warn（证据源=快照冻结）。
    const w1 = turnPair("warn-1", "静默会话", {}, { turn: 1 });
    status({ agent: w1.running, status: "running" });
    status({ agent: w1.idle, status: "idle" }); // 首轮正常通知，lastEndedTurn=1
    const beforeWarn = countDone();
    status({ agent: agentWithTitle("warn-1", "静默会话", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("warn-1", "静默会话", { turnEnd: 1 }), status: "idle" }); // 无新 closure → 快照冻结 + warn
    assert.equal(countDone(), beforeWarn, "(c) 无新证据轮不发 done");
    const warnLine = warns.find((t) => t.includes("warn-1"));
    assert.ok(warnLine !== undefined, "(c) 跳过路径输出 warn 日志");
    assert.match(warnLine, /完成判定跳过/, "(c) warn 标识跳过动作");
    assert.match(warnLine, /证据源=快照冻结/, "(c) warn 证据源标识快照冻结（abort-early 陈旧快照）");
    assert.match(warnLine, /快照turn=1/, "(c) warn 含快照源检测到的 turn");
    assert.match(warnLine, /推送turn=-/, "(c) warn 含推送源检测值（无则为 -）");
    assert.match(warnLine, /记忆turn=1/, "(c) warn 含记忆的 lastEndedTurn");

    // 设计内静默同样留痕：aborted 中断不发 done，但 warn 带 kind=aborted 可核对
    // （真实时序：本轮 aborted closure 落盘 → 白名单拒绝，非快照冻结）。
    const a1 = turnPair("abort-1", "中断会话", {}, { turn: 1, kind: "aborted" });
    status({ agent: a1.running, status: "running" });
    status({ agent: a1.idle, status: "idle" });
    assert.equal(countDone(), beforeWarn, "aborted 中断不发 done");
    assert.ok(warns.some((t) => t.includes("abort-1") && /kind=aborted/.test(t)), "aborted 静默留痕 kind=aborted");

    // disposed 清理辅源记忆：销毁后推送残留 turn 不再参与判定（防 Map 无界增长）。
    status({ agent: agentWithTitle("gc-1", "清理会话", { turnEnd: 3 }), status: "running" });
    sessionEvent({ id: "gc-1" }, turnEndEvent(3));
    disposed({ agent: agentWithTitle("gc-1", "清理会话") });
    status({ agent: agentWithTitle("gc-1", "清理会话", { turnEnd: 3 }), status: "idle" }); // 状态机+辅源已清零：不通知
    assert.equal(countDone(), beforeWarn, "disposed 清理后辅源残留不误报");

    // (d) 畸形载荷不毒化记忆（#284 复核闸 P1，B-2）：turn 非数字的推送 turn/end
    //     直接 skip 不落记忆——任何畸形证据既不能成 best、也不能推进记忆。
    status({ agent: agentWithTitle("mal-1", "畸形会话"), status: "running" }); // 无快照 turn/end（pushed/快照均缺失形态）
    sessionEvent({ id: "mal-1" }, { type: "turn/end", data: { turn: "x", reason: { kind: "completed" } } });
    sessionEvent({ id: "mal-1" }, { type: "turn/end", data: { turn: Number.NaN, reason: { kind: "completed" } } });
    status({ agent: agentWithTitle("mal-1", "畸形会话"), status: "idle" });
    assert.equal(countDone(), beforeWarn, "(d) 畸形载荷不误报 done");
    const malWarn = warns.find((t) => t.includes("mal-1"));
    assert.ok(malWarn !== undefined && /完成判定跳过/.test(malWarn), "(d) 畸形证据不可用走跳过路径 warn");
    assert.match(malWarn, /证据源=无 快照turn=- 推送turn=- 记忆turn=-/, "(d) 无任何可信证据（记忆未被毒化）");
    // 毒化回归反证：随后真实 turn=2 push completed 照常通知（修复前被 NaN 记忆吞掉）。
    status({ agent: agentWithTitle("mal-1", "畸形会话", { turnEnd: 2 }), status: "running" });
    sessionEvent({ id: "mal-1" }, turnEndEvent(2));
    status({ agent: agentWithTitle("mal-1", "畸形会话", { turnEnd: 2 }), status: "idle" });
    assert.equal(countDone(), beforeWarn + 1, "(d) 畸形载荷之后真实完成照常通知");
    // lastTurnEndOf 快照侧同款加固：畸形条目跳过继续倒序扫描，取上一条合法证据。
    const snapshotAgent = {
      id: "mal-2",
      session: {
        header: undefined,
        events: [
          { type: "turn/end", data: { turn: 7, reason: { kind: "completed" } } },
          { type: "turn/end", data: { turn: "x", reason: { kind: "completed" } } },
          { type: "session/title", data: { title: "T" } },
        ],
      },
    };
    assert.deepEqual(lastTurnEndOf(snapshotAgent), { turn: 7, kind: "completed" }, "(d) lastTurnEndOf 跳过非有限 turn 条目");
    assert.equal(lastTurnEndOf({ id: "mal-3", session: { header: undefined, events: [{ type: "turn/end", data: { turn: null, reason: { kind: "completed" } } }] } }), undefined, "(d) 仅畸形条目时返回 undefined");
  }

  // ── issue #290：根因 A 安全化与提交后置三态化（A-2/A-3/B-1/B-2/B-4）──

  // A-2：未提供 agents 时 completed 仍走 done 主分支且不抛（logger 无「处理失败」warn）
  {
    const infos = [];
    const warns = [];
    const a2Cfg = join(work, "a2-no-agents.json");
    writeFileSync(a2Cfg, JSON.stringify({ doneMergeWindowMs: 0 }));
    const { listeners } = await makeNotifier(
      work,
      { configFile: a2Cfg },
      { logger: { info: (t) => infos.push(t), warn: (t) => warns.push(t) } }
    );
    const status = listeners.get("agent/status")[0];
    const pair = turnPair("a2-1", "无 agents 主任务", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
    assert.equal(infos.filter((t) => /: done /.test(t)).length, 1, "A-2：无 agents 时 completed 走 done 主分支");
    assert.ok(!warns.some((t) => t.includes("agent/status 处理失败")), "A-2：无 'agent/status 处理失败' warn");
  }

  // A-3：agents 缺位时 fork 型（parentSession 无 origin、seedLength>0）保守走
  //     主任务 done（即使 notifySubagentDone=true 也不误判 subagent-done）；
  //     spawn 型（origin=subagent）仍按 origin 信号走 subagent 分支。
  {
    const a3Cfg = join(work, "a3-no-agents.json");
    writeFileSync(a3Cfg, JSON.stringify({ doneMergeWindowMs: 0, notifySubagentDone: true }));
    const infos = [];
    const { listeners } = await makeNotifier(work, { configFile: a3Cfg }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    // fork 型：无 origin、带 parentSession + seedLength，归属服务缺位 → 保守走 done
    const forkPair = () => turnPair("a3-fork", "fork 型无 agents", { parentSession: "ghost-parent", seedLength: 3 }, { turn: 1 });
    status({ agent: forkPair().running, status: "running" });
    status({ agent: forkPair().idle, status: "idle" });
    assert.equal(infos.filter((t) => /: done /.test(t)).length, 1, "A-3：agents 缺位 fork 型保守走 done");
    assert.ok(!infos.some((t) => /: subagent-done /.test(t)), "A-3：不误判 subagent-done");
    // spawn 型：origin 信号不依赖 agents，仍走 subagent 分支
    const spawnPair = () => turnPair("a3-spawn", "spawn 子任务", { subagent: true }, { turn: 2 });
    status({ agent: spawnPair().running, status: "running" });
    status({ agent: spawnPair().idle, status: "idle" });
    assert.equal(infos.filter((t) => /: subagent-done /.test(t)).length, 1, "A-3：spawn 型 origin 信号仍走 subagent 分支");
  }

  // B-1：开关禁用三态提交——notifyTaskDone=false 时 completed idle 不通知，
  //     但 lastEndedTurn 照常提交，同 turn 再现 idle 不重复处理。
  {
    const b1Cfg = join(work, "b1-off.json");
    writeFileSync(b1Cfg, JSON.stringify({ doneMergeWindowMs: 0, notifyTaskDone: false }));
    const infos = [];
    const warns = [];
    const { listeners } = await makeNotifier(work, { configFile: b1Cfg }, { logger: { info: (t) => infos.push(t), warn: (t) => warns.push(t) } });
    const status = listeners.get("agent/status")[0];
    const pair = turnPair("b1-1", "开关禁用任务", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
    assert.equal(infos.filter((t) => /: done /.test(t)).length, 0, "B-1：notifyTaskDone=false 主任务不通知");
    // 同 turn 再现 idle：lastEndedTurn 已提交 → 无新证据 → skip（不重复处理）；
    // 构造为「events 仍停 turn=1」的 abort-early 形态（快照 ≤ running 基线冻结）
    status({ agent: agentWithTitle("b1-1", "开关禁用任务", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("b1-1", "开关禁用任务", { turnEnd: 1 }), status: "idle" });
    assert.equal(infos.filter((t) => /: done /.test(t)).length, 0, "B-1：开关禁用后同 turn 再现 idle 不重复");
    assert.ok(warns.some((t) => t.includes("b1-1") && /完成判定跳过/.test(t)), "B-1：再现 idle 走跳过路径 warn 留痕");
  }

  // B-2：免打扰拦截后同 turn 再现 idle 不重复——quietHours 命中且 done 不在
  //     allowKinds 时，idle completed → 仅一条 suppressed 历史、无系统通知；
  //     同 turn 再现 idle → 不重复通知、不新增记录。
  {
    const qhAll = { enabled: true, start: "00:00", end: "23:59" };
    const b2Cfg = join(work, "b2-quiet.json");
    writeFileSync(b2Cfg, JSON.stringify({ doneMergeWindowMs: 0, quietHours: { ...qhAll, allowKinds: ["ask"] } }));
    const infos = [];
    const { listeners, routes } = await makeNotifier(work, { configFile: b2Cfg, historyFile: join(work, "b2-hist.jsonl") }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const historyRoute = routes.find((r) => r.path === ROUTES.history);
    const pair = turnPair("b2-1", "免打扰完成", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
    assert.ok(!infos.some((t) => /dsh-notifier: done /.test(t) && !t.includes("被免打扰拦截")), "B-2：免打扰拦截不发出系统通知");
    assert.ok(infos.some((t) => t.includes("被免打扰拦截")), "B-2：拦截记录日志");
    const records = await waitForHistory(historyRoute, (r) => r.some((e) => e.kind === "done" && e.suppressed === "quiet"));
    assert.equal(records.filter((e) => e.kind === "done" && e.suppressed === "quiet").length, 1, "B-2：仅一条 suppressed:quiet 历史");
    // 同 turn 再现 idle：免打扰拦截也是三态提交之一（lastEndedTurn 已推进）→ 不重复
    status({ agent: agentWithTitle("b2-1", "免打扰完成", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("b2-1", "免打扰完成", { turnEnd: 1 }), status: "idle" });
    const after = await waitForHistory(historyRoute, (r) => r.length > records.length, 500);
    assert.equal(after.length, records.length, "B-2：同 turn 再现 idle 不新增历史记录");
  }

  // B-4：批次按「入队成功」提交、与聚合 flush 成败解耦——doneMergeWindowMs>0
  //     时首条完成入队即推进 lastEndedTurn（窗口内同 turn 再现不重复）。
  {
    const b4Cfg = join(work, "b4-merge.json");
    writeFileSync(b4Cfg, JSON.stringify({ doneMergeWindowMs: 5000 }));
    const infos = [];
    const { listeners } = await makeNotifier(work, { configFile: b4Cfg }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const pair = turnPair("b4-1", "合并窗口任务", {}, { turn: 1 });
    status({ agent: pair.running, status: "running" });
    status({ agent: pair.idle, status: "idle" });
    assert.equal(infos.filter((t) => /: done /.test(t)).length, 1, "B-4：首条完成即时通知并入队");
    // 窗口未 flush 时同 turn 再现 idle：入队成功已提交 lastEndedTurn → 不重复
    status({ agent: agentWithTitle("b4-1", "合并窗口任务", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("b4-1", "合并窗口任务", { turnEnd: 1 }), status: "idle" });
    assert.equal(infos.filter((t) => /: done /.test(t)).length, 1, "B-4：窗口内同 turn 再现 idle 不重复（入队即提交）");
  }

  // B-4 flush 时序：首条入队即提交（不依赖 flush 结果）——窗口到点正常 flush
  //     补发聚合条后，已提交 turn 不回退（再现 idle 不重复）。
  //     （「flush 阶段 notify 抛错」路径为产品 setTimeout 异步回调的既有行为，
  //     触发会 uncaught、与 Stryker tap-bridge 冲突，故以「提交点先于 flush」
  //     的时序验证覆盖——见 PR 断言表 B-4 漂移说明。）
  {
    const b4fCfg = join(work, "b4-flush-ok.json");
    writeFileSync(b4fCfg, JSON.stringify({ doneMergeWindowMs: 30 }));
    const infos = [];
    const { listeners } = await makeNotifier(work, { configFile: b4fCfg }, loggingOverride(infos));
    const status = listeners.get("agent/status")[0];
    const doneCount = () => infos.filter((t) => /: done /.test(t)).length;
    const pairA = () => turnPair("b4f-a", "flush 后 A", {}, { turn: 1 });
    const pairB = () => turnPair("b4f-b", "flush 后 B", {}, { turn: 1 });
    // 两条完成进入同一聚合窗口（首条即时、第二条入队挂起）
    status({ agent: pairA().running, status: "running" });
    status({ agent: pairA().idle, status: "idle" });
    status({ agent: pairB().running, status: "running" });
    status({ agent: pairB().idle, status: "idle" });
    assert.equal(doneCount(), 1, "B-4：窗口内首条即时、第二条挂起");
    // 等窗口到点：flush 补发聚合条（正常路径）
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(doneCount(), 2, "B-4：flush 补发聚合条");
    assert.ok(infos.some((t) => /: done /.test(t) && t.includes("另有 1 个任务已完成")), "B-4：聚合条文案带计数");
    // 已提交 turn 不回退：flush 完成后再现 idle（无新 closure 形态）不重复
    status({ agent: agentWithTitle("b4f-a", "flush 后 A", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("b4f-a", "flush 后 A", { turnEnd: 1 }), status: "idle" });
    status({ agent: agentWithTitle("b4f-b", "flush 后 B", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("b4f-b", "flush 后 B", { turnEnd: 1 }), status: "idle" });
    assert.equal(doneCount(), 2, "B-4：flush 后已提交 turn 不回退重发");
  }

  // ── issue #290 阶段二：重载窗口后首轮 live turn 仍通知（D-1）与
  //    重载不引入假阳性（D-2）——独立实例模拟插件重载（新 fiber 的
  //    agentStates / eventStreamEnds 记忆为空）──
  {
    // D-1：重载窗口后首轮 live turn 仍通知（快照兜底补证）。
    // 构造：上一轮 turn=1 已落盘（重载前已派发、新 fiber 未记忆，push 缺失），
    // 本轮 live turn=2 completed 落盘后 running→idle——快照较 running 基线推进，
    // 走快照兜底补证 → 恰一条 done，不因记忆重置静默。
    const d1Cfg = join(work, "d1-reload.json");
    writeFileSync(d1Cfg, JSON.stringify({ doneMergeWindowMs: 0 }));
    const infos1 = [];
    const warns1 = [];
    const { listeners: l1 } = await makeNotifier(
      work,
      { configFile: d1Cfg, historyFile: join(work, "d1-hist.jsonl") },
      { logger: { info: (t) => infos1.push(t), warn: (t) => warns1.push(t) } }
    );
    const status1 = l1.get("agent/status")[0];
    const d1 = turnPair("d1-1", "重载后任务", {}, { turn: 2 }, { turn: 1 }); // prev=1（重载前 closure）、this=2（本轮 live）
    status1({ agent: d1.running, status: "running" });
    status1({ agent: d1.idle, status: "idle" });
    assert.equal(infos1.filter((t) => /: done /.test(t)).length, 1, "D-1：重载后首轮 live turn 经快照兜底通知（恰一条）");
    assert.ok(!warns1.some((t) => t.includes("d1-1")), "D-1：重载后首轮 live turn 不走跳过路径（无 warn）");

    // D-2：重载后 abort-early（本轮无新 closure）idle 仍静默——running 基线
    //     捕获上一轮 turn=1 completed，idle 时快照仍 turn=1（≤ 基线）→ 冻结，
    //     不因记忆重置把旧证据当新轮完成。
    const d2Cfg = join(work, "d2-reload-abort.json");
    writeFileSync(d2Cfg, JSON.stringify({ doneMergeWindowMs: 0 }));
    const infos2 = [];
    const warns2 = [];
    const { listeners: l2 } = await makeNotifier(
      work,
      { configFile: d2Cfg, historyFile: join(work, "d2-hist.jsonl") },
      { logger: { info: (t) => infos2.push(t), warn: (t) => warns2.push(t) } }
    );
    const status2 = l2.get("agent/status")[0];
    status2({ agent: agentWithTitle("d2-1", "重载后中断", { turnEnd: 1 }), status: "running" });
    status2({ agent: agentWithTitle("d2-1", "重载后中断", { turnEnd: 1 }), status: "idle" });
    assert.equal(infos2.filter((t) => /: done /.test(t)).length, 0, "D-2：重载后 abort-early 静默（不把旧证据当新轮完成）");
    const d2Warn = warns2.find((t) => t.includes("d2-1"));
    assert.ok(d2Warn !== undefined && /完成判定跳过/.test(d2Warn), "D-2：重载后 abort-early 跳过路径 warn 留痕");
    assert.match(d2Warn, /证据源=快照冻结/, "D-2：warn 标识快照冻结（陈旧快照拦截）");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
