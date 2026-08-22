// @ts-nocheck
/**
 * dsh-notifier — e2e：任务完成状态机 / 错误通知与合并 / 子代理分流。
 *
 * 覆盖：agent/status per-agent 状态机（多会话互不误报、连续 idle 不重复、
 * disposed 清理）；完成风暴聚合（首条即时 + 窗口补发聚合条）；agent/error
 * 通知与滚动窗口合并（含窗口过期计数、0=关闭）；子代理完成四场景
 * （fork 派生走 done / 默认关 / subagent-done 独立类型 / S2 开关组合）。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assert, makeNotifier, agentWithTitle, waitMergeWindow } from "./helpers.ts";

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
    status({ agent: agentWithTitle("storm-1", "并行任务A", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("storm-1", "并行任务A", { turnEnd: 1 }), status: "idle" });
    assert.equal(infos.length, 5, "聚合窗口首条即时通知");
    status({ agent: agentWithTitle("storm-2", "并行任务B", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("storm-2", "并行任务B", { turnEnd: 1 }), status: "idle" });
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

    // 判定依据回归（issue #7）：单用 header.origin === 'subagent' 识别子代理。
    // 反例 1：只带 parentSession（无 origin）的 fork/派生会话必须走 done（不被静默）。
    {
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: join(work, "sub-fork.json") }, loggingOverride(infos));
      const status = listeners.get("agent/status")[0];
      status({ agent: agentWithTitle("fork-1", "fork 派生会话", { parentSession: "parent-x", turnEnd: 1 }), status: "running" });
      status({ agent: agentWithTitle("fork-1", "fork 派生会话", { parentSession: "parent-x", turnEnd: 1 }), status: "idle" });
      assert.equal(infos.length, 1, "仅 parentSession（无 origin）的会话走主任务完成，不被静默");
      assert.match(infos[0], /done/, "fork/派生会话发 done 而非 subagent-done");
      // 反例 2：主会话（无 header / 无 origin）必须走 done（原 bug 回归防护）。
      // fork-1 与 main-x 同为 done 类型会被聚合窗口合并，故先等窗口过期再验 main-x。
      await waitMergeWindow();
      status({ agent: agentWithTitle("main-x", "主任务", { turnEnd: 1 }), status: "running" });
      status({ agent: agentWithTitle("main-x", "主任务", { turnEnd: 1 }), status: "idle" });
      assert.equal(infos.length, 2, "主会话完成走 done");
      assert.match(infos[1], /done/);
    }

    // 默认关：子代理完成不通知，主任务完成不受影响
    {
      const infos = [];
      const { listeners } = await makeNotifier(work, { configFile: join(work, "sub-default.json") }, loggingOverride(infos));
      const status = listeners.get("agent/status")[0];
      status({ agent: agentWithTitle("sub-1", "子任务A", { subagent: true, turnEnd: 1 }), status: "running" });
      status({ agent: agentWithTitle("sub-1", "子任务A", { subagent: true, turnEnd: 1 }), status: "idle" });
      assert.equal(infos.length, 0, "notifySubagentDone 默认关：子代理完成不通知");
      status({ agent: agentWithTitle("main-1", "主任务", { turnEnd: 1 }), status: "running" });
      status({ agent: agentWithTitle("main-1", "主任务", { turnEnd: 1 }), status: "idle" });
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
      status({ agent: agentWithTitle("sub-2", "子任务B", { subagent: true, turnEnd: 1 }), status: "running" });
      status({ agent: agentWithTitle("sub-2", "子任务B", { subagent: true, turnEnd: 1 }), status: "idle" });
      assert.equal(infos.length, 1);
      assert.match(infos[0], /subagent-done/, "子代理完成用独立事件类型");
      assert.match(infos[0], /子任务「子任务B」已完成/, "subagent-done 文案带任务标题");
      assert.match(infos[0], /耗时：/, "subagent-done 带耗时");
      assert.ok(!infos[0].includes("sub-2"), "子代理完成通知不暴露会话 id");
      // 等 subagent-done 的 3s 聚合窗口结束（否则主任务完成会被聚合挂起）
      await waitMergeWindow();
      status({ agent: agentWithTitle("main-2", "主任务2", { turnEnd: 1 }), status: "running" });
      status({ agent: agentWithTitle("main-2", "主任务2", { turnEnd: 1 }), status: "idle" });
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
      status({ agent: agentWithTitle("sub-3", "子任务C", { subagent: true, turnEnd: 1 }), status: "running" });
      status({ agent: agentWithTitle("sub-3", "子任务C", { subagent: true, turnEnd: 1 }), status: "idle" });
      assert.equal(infos.length, 1, "notifyTaskDone=false 不拦截子代理完成（S2）");
      assert.match(infos[0], /subagent-done/);
      status({ agent: agentWithTitle("main-3", "主任务3", { turnEnd: 1 }), status: "running" });
      status({ agent: agentWithTitle("main-3", "主任务3", { turnEnd: 1 }), status: "idle" });
      assert.equal(infos.length, 1, "notifyTaskDone=false 主任务不通知");
      // 既有 bug 修复回归：notifyTaskDone=false 时 idle 无条件重置状态，
      // 之后重开开关不会把旧的 running 误报为完成
      status({ agent: agentWithTitle("main-3", "主任务3", { turnEnd: 1 }), status: "running" });
      assert.equal(infos.length, 1, "running 仍不通知");
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
