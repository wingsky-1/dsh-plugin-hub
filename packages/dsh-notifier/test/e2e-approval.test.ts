// @ts-nocheck
/**
 * dsh-notifier — e2e：审批请求通知（approval/request waterfall）。
 *
 * 覆盖：五个事件监听器注册面；审批通知（工具中文名/任务标题/申请理由/
 * 行动建议，不短路、不暴露会话 id）；无标题降级；next 抛错原样传播；
 * notifyAsk=false 不通知；免打扰紧急例外 allowKinds（M4）。
 */
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { assert, makeNotifier, agentWithTitle } from "./helpers.ts";

/** 带 info 收集的 logger 覆盖。 */
function loggingOverride(infos) {
  return { logger: { warn: () => {}, info: (t) => infos.push(t) } };
}

const work = mkdtempSync(join(tmpdir(), "dnotify-e2e-approval-"));
try {
  // 监听器注册面 + 审批通知主流程
  {
    const infos = [];
    const { listeners } = await makeNotifier(work, {}, loggingOverride(infos));

    const approval = listeners.get("approval/request")[0];
    const status = listeners.get("agent/status")[0];
    const error = listeners.get("agent/error")[0];
    const turnStop = listeners.get("agent/turn-stopping")[0];
    const disposed = listeners.get("agent/disposed")[0];
    assert.ok(approval && status && error && turnStop && disposed, "五个事件监听器已注册");
    assert.equal(listeners.has("tools/pre-execute"), false, "不再挂 pre-execute（真实审批走 approval/request）");

    // approval/request：通知（工具中文名/任务标题/申请理由），不短路返回 next 结果
    const req = { toolName: "pwsh", agent: agentWithTitle("session-1", "优化 notifier 插件"), reason: "escalate sandbox to workspace-write: 需要写文件", signal: { aborted: false } };
    const outcome = await approval(req, async () => "allowed-once");
    assert.equal(outcome, "allowed-once", "不短路，返回 next 结果");
    assert.equal(infos.length, 1);
    assert.match(infos[0], /ask/);
    assert.match(infos[0], /任务「优化 notifier 插件」等待审批（工具「PowerShell 命令」）/, "审批通知带任务标题与工具中文名");
    assert.match(infos[0], /理由：escalate sandbox to workspace-write: 需要写文件/);
    assert.match(infos[0], /确认或拒绝/, "审批通知带行动建议");
    assert.ok(!infos[0].includes("session-"), "审批通知不暴露内部会话 id");

    // 无会话标题：降级为仅工具名
    const outcome2 = await approval({ toolName: "bash", agent: agentWithTitle("session-9", null) }, async () => "allowed-once");
    assert.equal(outcome2, "allowed-once");
    assert.match(infos[1], /工具「终端命令」等待审批/, "无标题时仅显示工具中文名");
    assert.ok(!infos[1].includes("任务「"), "无标题时不显示任务行");
    assert.ok(!infos[1].includes("session-9"), "无标题路径也不暴露会话 id");

    // next 抛错 → 原样传播（waterfall 兜底由上层负责），通知已先行发出
    await assert.rejects(approval(req, async () => {
      throw new Error("boom");
    }), /boom/);
    assert.equal(infos.length, 3, "next 抛错前通知已发出");
  }

  // notifyAsk=false（configFile）时 approval/request 不通知、不短路
  {
    const askOffCfg = join(work, "ask-off.json");
    writeFileSync(askOffCfg, JSON.stringify({ notifyAsk: false }));
    const infos = [];
    const { listeners } = await makeNotifier(work, { configFile: askOffCfg }, loggingOverride(infos));
    const approval = listeners.get("approval/request")[0];
    const outcome = await approval({ toolName: "bash", agent: { id: "session-1" } }, async () => "allowed-once");
    assert.equal(outcome, "allowed-once", "不短路");
    assert.equal(infos.length, 0, "notifyAsk=false 不通知");
  }

  // M4 免打扰紧急例外：allowKinds 中的 kind 在免打扰时段仍通知
  {
    const qhOn = { enabled: true, start: "00:00", end: "23:59" };
    const cfgAsk = join(work, "qh-ask.json");
    writeFileSync(cfgAsk, JSON.stringify({ quietHours: { ...qhOn, allowKinds: ["ask"] } }));
    const infos = [];
    const { listeners } = await makeNotifier(work, { configFile: cfgAsk, historyFile: join(work, "history-qh1.jsonl") }, loggingOverride(infos));
    const approval = listeners.get("approval/request")[0];
    await approval({ toolName: "pwsh", agent: agentWithTitle("qh-1", "免打扰审批", { turnEnd: 1 }) }, async () => "ok");
    assert.equal(infos.length, 1, "免打扰期间 ask 仍通知（紧急例外 allowKinds）");
    assert.match(infos[0], /ask/);

    // allowKinds 为空/不含 ask：免打扰生效则静默
    const cfgNone = join(work, "qh-none.json");
    writeFileSync(cfgNone, JSON.stringify({ quietHours: { ...qhOn, allowKinds: [] } }));
    const infos2 = [];
    const { listeners: listeners2 } = await makeNotifier(work, { configFile: cfgNone, historyFile: join(work, "history-qh2.jsonl") }, loggingOverride(infos2));
    await listeners2.get("approval/request")[0]({ toolName: "pwsh", agent: { id: "qh-2" } }, async () => "ok");
    assert.equal(infos2.filter((t) => !t.includes("被免打扰拦截")).length, 0, "无 allowKinds 时免打扰不产生实际通知");
    assert.ok(infos2.some((t) => t.includes("被免打扰拦截")), "被拦截仍记录日志（可核对发没发）");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
