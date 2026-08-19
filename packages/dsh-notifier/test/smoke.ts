// @ts-nocheck
/**
 * dsh-notifier — 宿主端冒烟测试（fake ctx，无网络）。
 *
 * 覆盖：
 * - normalizeConfig：默认值/部分覆盖/非法值丢弃（含 errorMergeWindowMs）
 * - parseHHMM / isInQuietHours：正常/跨午夜/禁用/非法
 * - prettyToolName：常见工具中文映射 / MCP 美化 / 未知原样
 * - sessionTitleOf：会话标题提取（含截断/容错）
 * - approval/request：审批通知（工具中文名/任务标题/申请理由，不短路，
 *   不暴露会话 id，无标题降级）/
 *   next 抛错原样传播 / notifyAsk=false 不通知
 * - agent/status：per-agent 状态机，多会话互不误报；disposed 清理；
 *   子代理分流（delegationDepth≥1 → subagent-done，独立开关默认关，
 *   notifyTaskDone=false 不拦截）；中断抑制（turn/end aborted 静默、
 *   error/blocked 静默（不误报完成）、S1 无新 turn/end closure 静默、
 *   中断/失败后继续正常通知）
 * - agent/error：通知（任务标题/轮次步骤/错误信息）；窗口内合并、窗口
 *   过期带合并计数
 * - turn-stopping：默认不通知（config 开启后通知）
 * - 路由：config GET/PUT（配置持久化）、events SSE（text/event-stream）、403
 * - 客户端路由常量一致性
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { assertClientProductContract, assertClientSourceContract } from "../../../test/smoke-lib.ts";

const pkgDir = fileURLToPath(new URL("..", import.meta.url));
import { apply, ROUTES, isLoopbackRequest, normalizeConfig, parseHHMM, isInQuietHours, DEFAULT_CONFIG, formatDuration, prettyToolName, sessionTitleOf, sanitizeErrorText, buildSystemCommand } from "../lib/index.js";

// ---------------------------------------------------------------- 纯函数

const DEFAULT_CONFIG_UNTOUCHED = JSON.parse(JSON.stringify(DEFAULT_CONFIG));

assert.equal(normalizeConfig(undefined).notifyAsk, true);
const merged = normalizeConfig({ notifyAsk: false, bogus: 1, quietHours: { enabled: true, start: "23:30", end: "06:00", x: 1 } });
assert.equal(merged.notifyAsk, false);
assert.equal(merged.notifyTaskDone, true);
assert.equal(merged.quietHours.enabled, true);
assert.equal(merged.quietHours.start, "23:30");
assert.equal(merged.bogus, 1, "未知键透传保留（防降级丢键）");
assert.equal(normalizeConfig({ quietHours: { start: "25:00" } }).quietHours.start, "22:00", "非法 HH:MM(25:00) 丢弃回默认");
assert.equal(normalizeConfig({ quietHours: { start: "9:30" } }).quietHours.start, "22:00", "非两位 HH:MM 丢弃");
assert.equal(normalizeConfig({ notifyAsk: "yes" }).notifyAsk, true, "非布尔丢弃");
assert.equal(normalizeConfig({ notifyWhenVisible: true }).notifyWhenVisible, true, "页面可见也弹可配置");
assert.equal(normalizeConfig({ notifyWhenVisible: "x" }).notifyWhenVisible, false, "非布尔丢弃");
assert.equal(normalizeConfig({ notifyQuestion: false }).notifyQuestion, false, "提问通知可配置");
assert.equal(normalizeConfig({ notifyQuestion: "x" }).notifyQuestion, true, "非布尔丢弃回默认");
assert.equal(DEFAULT_CONFIG_UNTOUCHED.quietHours.enabled, false, "normalizeConfig 不污染默认配置");
assert.equal(normalizeConfig({ errorMergeWindowMs: 5000 }).errorMergeWindowMs, 5000, "合并窗口可配置");
assert.equal(normalizeConfig({ errorMergeWindowMs: -1 }).errorMergeWindowMs, DEFAULT_CONFIG.errorMergeWindowMs, "非法窗口丢弃");
assert.equal(normalizeConfig({ errorMergeWindowMs: "x" }).errorMergeWindowMs, DEFAULT_CONFIG.errorMergeWindowMs, "非数字窗口丢弃");
assert.equal(DEFAULT_CONFIG.notifySubagentDone, false, "子代理完成通知默认关闭");
assert.equal(normalizeConfig({ notifySubagentDone: true }).notifySubagentDone, true, "子代理完成可配置");
assert.equal(normalizeConfig({ notifySubagentDone: "x" }).notifySubagentDone, false, "非布尔丢弃回默认");

assert.equal(parseHHMM("22:00"), 1320);
assert.equal(parseHHMM("08:30"), 510);
assert.ok(Number.isNaN(parseHHMM("8:30")));
assert.ok(Number.isNaN(parseHHMM("25:00")));

assert.equal(isInQuietHours(new Date(2026, 0, 1, 23, 0), { enabled: true, start: "22:00", end: "08:00" }), true, "跨午夜晚间");
assert.equal(isInQuietHours(new Date(2026, 0, 1, 7, 0), { enabled: true, start: "22:00", end: "08:00" }), true, "跨午夜凌晨");
assert.equal(isInQuietHours(new Date(2026, 0, 1, 12, 0), { enabled: true, start: "22:00", end: "08:00" }), false, "中午不静默");
assert.equal(isInQuietHours(new Date(2026, 0, 1, 12, 0), { enabled: false, start: "22:00", end: "08:00" }), false, "禁用");
assert.equal(isInQuietHours(new Date(2026, 0, 1, 9, 0), { enabled: true, start: "09:00", end: "17:00" }), true, "同日内");
assert.equal(isInQuietHours(new Date(2026, 0, 1, 8, 0), { enabled: true, start: "09:00", end: "17:00" }), false);

// ---------------------------------------------------------------- 通知文案工具函数

assert.equal(formatDuration(45000), "45 秒");
assert.equal(formatDuration(135000), "2 分 15 秒");
assert.equal(formatDuration(3725000), "1 小时 2 分 5 秒");
assert.equal(formatDuration(0), "0 秒");
assert.equal(prettyToolName("pwsh"), "PowerShell 命令", "常见工具映射中文名");
assert.equal(prettyToolName("ssh_exec"), "SSH 远程执行");
assert.equal(prettyToolName("web_search"), "联网搜索");
assert.equal(prettyToolName("unknown_tool"), "unknown_tool", "未知工具原样");
assert.equal(prettyToolName("mcp__my-server__read_file"), 'MCP 服务器 "my-server" 的工具 "read_file"');
assert.equal(prettyToolName("mcp__srv__a__b"), 'MCP 服务器 "srv" 的工具 "a__b"');
assert.equal(prettyToolName(undefined), "?");

// sanitizeErrorText：路径/令牌/密钥打码 + 截断
assert.equal(sanitizeErrorText("failed /home/me/dev/x.yaml: EACCES"), "failed <path>: EACCES", "用户路径打码");
assert.equal(sanitizeErrorText("token: 3f9a2b7c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"), "token: <token>", "长 hex 令牌打码");
assert.ok(!sanitizeErrorText("password=s3cr3t").includes("s3cr3t"), "密钥赋值掩蔽");
assert.equal(sanitizeErrorText("错".repeat(500)).length, 300, "截断 300");
assert.equal(sanitizeErrorText("普通错误"), "普通错误", "普通文本原样");
assert.equal(sanitizeErrorText("x".repeat(40)), "<token>", "长重复字符按令牌打码");

// M4 配置归一化：askRemindMin / quietHours.allowKinds
assert.equal(normalizeConfig({ askRemindMin: 3 }).askRemindMin, 3, "审批提醒分钟可配");
assert.equal(normalizeConfig({ askRemindMin: 0 }).askRemindMin, 0, "0=关闭审批提醒");
assert.equal(normalizeConfig({ askRemindMin: "x" }).askRemindMin, DEFAULT_CONFIG.askRemindMin, "非法提醒分钟回默认 5");
assert.deepEqual(normalizeConfig({ quietHours: { allowKinds: ["ask", "bogus", "error"] } }).quietHours.allowKinds, ["ask", "error"], "allowKinds 白名单过滤");

// 合并/清理配置：doneMergeWindowMs / errorMergeWindowMs(0=关) / historyMaxAgeDays
assert.equal(normalizeConfig({ doneMergeWindowMs: 0 }).doneMergeWindowMs, 0, "完成聚合窗口 0=关闭");
assert.equal(normalizeConfig({ doneMergeWindowMs: 1500 }).doneMergeWindowMs, 1500, "完成聚合窗口可配");
assert.equal(normalizeConfig({ doneMergeWindowMs: "x" }).doneMergeWindowMs, DEFAULT_CONFIG.doneMergeWindowMs, "非法完成窗口回默认");
assert.equal(normalizeConfig({ errorMergeWindowMs: 0 }).errorMergeWindowMs, 0, "错误合并窗口 0=关闭");
assert.equal(normalizeConfig({ errorMergeWindowMs: -1 }).errorMergeWindowMs, DEFAULT_CONFIG.errorMergeWindowMs, "负数错误窗口回默认");
assert.equal(normalizeConfig({ historyMaxAgeDays: 30 }).historyMaxAgeDays, 30, "按天清理可配");
assert.equal(normalizeConfig({ historyMaxAgeDays: 0 }).historyMaxAgeDays, 0, "按天清理 0=关");

// buildSystemCommand：Windows/macOS/Linux 参数形态（smoke 断言 spawn 参数）
const winArgs = buildSystemCommand("win32", "标题", "内容 -x", { silent: true, toastScript: "t.ps1" });
assert.equal(winArgs[0], "powershell");
assert.ok(winArgs.includes("-Silent"), "silent 时追加 -Silent");
assert.ok(winArgs.some((a) => a === "-Title=标题"), "单 token -Title= 传参");
assert.ok(winArgs.some((a) => a === "-Message=内容 -x"), "含空格/前导 '-' 的消息单 token 不被拆");
const macArgs = buildSystemCommand("darwin", "标题", '说"话', { silent: false, toastScript: "t.ps1" });
assert.equal(macArgs[0], "osascript");
assert.match(macArgs.join(" "), /display notification/);
assert.ok(macArgs.join(" ").includes('sound name "Glass"'), "非静默带 Glass 提示音");
assert.ok(!macArgs.join(" ").includes('说话"'), "消息内引号被转义");
assert.equal(buildSystemCommand("linux", "t", "m", { silent: true, notifySendAvailable: false, toastScript: "t.ps1" }), null, "notify-send 不可用返回 null");
assert.deepEqual(buildSystemCommand("linux", "t", "m", { silent: true, toastScript: "t.ps1" }), ["notify-send", "t", "m"]);

// sessionTitleOf：从 session.events 的 session/title 事件取标题
const titledAgent = {
  id: "session-1",
  session: { events: [{ type: "other", data: {} }, { type: "session/title", data: { title: "优化 notifier 插件" } }] },
};
assert.equal(sessionTitleOf(titledAgent), "优化 notifier 插件", "取最后一个标题事件");
assert.equal(sessionTitleOf({ id: "session-1", session: { events: [] } }), undefined, "无标题事件返回 undefined");
assert.equal(sessionTitleOf({ id: "session-1" }), undefined, "无 session 返回 undefined");
assert.equal(sessionTitleOf(undefined), undefined, "无 agent 返回 undefined");
assert.equal(sessionTitleOf({ id: "session-1", session: { events: "bad" } }), undefined, "events 非数组容错");
assert.equal(
  sessionTitleOf({ session: { events: [{ type: "session/title", data: { title: "x".repeat(80) } }] } }),
  "x".repeat(40),
  "标题截断 40 字符"
);

// ---------------------------------------------------------------- loopback

function fakeReq(overrides = {}) {
  return {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
    method: "GET",
    url: "/",
    ...overrides,
  };
}
assert.equal(isLoopbackRequest(fakeReq()), true);
assert.equal(isLoopbackRequest(fakeReq({ socket: { remoteAddress: "10.0.0.2" } })), false);

// ---------------------------------------------------------------- fake ctx + apply

function makeFakeCtx(overrides = {}) {
  const routes = [];
  const listeners = new Map();
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
      return () => {};
    },
    effect(fn) {
      // 真实 cordis 语义：fn 立即同步执行，返回值收集为 disposer（卸载时调用）。
      const disposer = fn();
      return typeof disposer === "function" ? disposer : () => {};
    },
    ...overrides,
  };
  return { ctx, routes, listeners };
}

function makeRes() {
  const rec = { status: 0, text: "" };
  return {
    rec,
    res: {
      writeHead(status, headers) {
        rec.status = status;
        rec.headers = headers;
      },
      write(text) {
        rec.text += text;
      },
      end(text) {
        if (text !== undefined) rec.text += text;
      },
      on() {},
    },
  };
}

const work = mkdtempSync(join(tmpdir(), "dnotify-"));
const storeFile = join(work, "config.json");

async function makeNotifier(config = {}) {
  const { ctx, routes, listeners } = makeFakeCtx();
  await apply(ctx, {
    enabled: true,
    configFile: storeFile,
    toastScript: join(work, "toast.ps1"),
    historyFile: join(work, "history.jsonl"),
    ...config,
  });
  return { ctx, routes, listeners };
}

// 记录通知的辅助：替换 notify 不可行（闭包），改用监听 SSE 连接广播 + systemNotify 不可见。
// 通过检查 logger.info 调用次数验证通知触发。
function makeLoggingCtx() {
  const infos = [];
  const { ctx, routes, listeners } = makeFakeCtx({
    logger: { warn: () => {}, info: (text) => infos.push(text) },
  });
  return { ctx, routes, listeners, infos };
}

// 带会话标题/子代理深度/turn/end 的 agent 辅助（模拟 dsh-session-title 与
// dsh-agent-loop 写入的日志；真实宿主跑完一轮必有 turn/end 落盘）。
// opts.turnEnd：turn 号（有则追加一条 turn/end 事件）；
// opts.turnEndKind：reason.kind（默认 completed，aborted 模拟用户中断）；
// opts.depth：header.delegationDepth（≥1 模拟子代理）。
function agentWithTitle(id, title, opts = {}) {
  const events = [];
  if (opts.turnEnd !== undefined) {
    events.push({ type: "turn/end", data: { turn: opts.turnEnd, reason: { kind: opts.turnEndKind ?? "completed" } } });
  }
  if (title) events.push({ type: "session/title", data: { title } });
  return {
    id,
    session: {
      header: opts.depth !== undefined ? { delegationDepth: opts.depth } : undefined,
      events,
    },
  };
}

{
  const { ctx, routes, listeners, infos } = makeLoggingCtx();
  await apply(ctx, { enabled: true, configFile: storeFile, toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });

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

  // agent/status：per-agent 状态机，多会话互不误报（真实宿主跑完一轮必有 turn/end，故 idle 断言带 turnEnd）
  status({ agent: agentWithTitle("session-1", "优化 notifier 插件"), status: "running" });
  status({ agent: agentWithTitle("session-2", "并行评审代码"), status: "running" });
  assert.equal(infos.length, 3, "running 不通知");
  status({ agent: agentWithTitle("session-2", "并行评审代码", { turnEnd: 1 }), status: "idle" });
  assert.equal(infos.length, 4, "session-2 完成通知一次");
  assert.match(infos[3], /done/);
  assert.match(infos[3], /任务「并行评审代码」已完成/, "完成通知带任务标题");
  assert.match(infos[3], /耗时：/, "完成通知带耗时");
  assert.ok(!infos[3].includes("session-"), "完成通知不暴露会话 id");
  // 完成风暴聚合窗口（3s）：等上一处完成的窗口结束，保证同 agent 下一轮是独立窗口
  await new Promise((resolve) => setTimeout(resolve, 3200));
  status({ agent: agentWithTitle("session-1", "优化 notifier 插件", { turnEnd: 1 }), status: "idle" });
  assert.equal(infos.length, 5, "session-1 完成独立通知");
  assert.match(infos[4], /任务「优化 notifier 插件」已完成/);
  status({ agent: agentWithTitle("session-1", "优化 notifier 插件"), status: "idle" });
  assert.equal(infos.length, 5, "连续 idle 不重复通知");
  status({ agent: agentWithTitle("session-2", "并行评审代码"), status: "idle" });
  assert.equal(infos.length, 5, "session-2 无 running 记录不通知");

  // agent/disposed：清理状态机，防会话销毁后残留 idle 误报
  status({ agent: agentWithTitle("session-3", "临时会话"), status: "running" });
  disposed({ agent: agentWithTitle("session-3", "临时会话") });
  status({ agent: agentWithTitle("session-3", "临时会话"), status: "idle" });
  assert.equal(infos.length, 5, "disposed 清理后残留 idle 不误报");

  // agent/error：通知（任务标题/轮次步骤/错误信息）；60 秒窗口内同类错误合并
  error({ agent: agentWithTitle("session-1", "优化 notifier 插件"), turn: 1, step: 1, error: new Error("测试错误信息") });
  assert.equal(infos.length, 6);
  assert.match(infos[5], /error/);
  assert.match(infos[5], /任务「优化 notifier 插件」执行出错/, "错误通知带任务标题");
  assert.match(infos[5], /第 1 轮第 1 步：测试错误信息/, "轮次/步骤与错误信息同行");
  assert.ok(!infos[5].includes("session-"), "错误通知不暴露会话 id");
  error({ agent: agentWithTitle("session-1", "优化 notifier 插件"), turn: 1, step: 2, error: new Error("窗口内错误") });
  assert.equal(infos.length, 6, "窗口内同类错误合并，不重复通知");
  error({ agent: agentWithTitle("session-2", "并行评审代码"), turn: 1, step: 3, error: new Error("其他会话错误") });
  assert.equal(infos.length, 7, "不同会话独立合并窗口");
  assert.match(infos[6], /任务「并行评审代码」执行出错/);

  // turn-stopping：默认不通知；serial 事件签名 cb(payload) 无 next——必须不抛错
  let threw = false;
  try {
    await turnStop({ agent: agentWithTitle("session-1", "优化 notifier 插件"), turn: 4 });
  } catch (error) {
    threw = true;
  }
  assert.equal(threw, false, "serial 事件（无 next 参数）下监听器不抛错");
  assert.equal(infos.length, 7, "turn-stopping 默认不通知");

  // 完成风暴聚合：窗口内第二条完成不即时，3s 后补发聚合条（防并行收尾刷屏）
  await new Promise((resolve) => setTimeout(resolve, 3200)); // 窗口清零（error/turn 无完成窗口）
  status({ agent: agentWithTitle("storm-1", "并行任务A", { turnEnd: 1 }), status: "running" });
  status({ agent: agentWithTitle("storm-1", "并行任务A", { turnEnd: 1 }), status: "idle" });
  assert.equal(infos.length, 8, "聚合窗口首条即时通知");
  status({ agent: agentWithTitle("storm-2", "并行任务B", { turnEnd: 1 }), status: "running" });
  status({ agent: agentWithTitle("storm-2", "并行任务B", { turnEnd: 1 }), status: "idle" });
  assert.equal(infos.length, 8, "窗口内第二条挂起不即时发");
  await new Promise((resolve) => setTimeout(resolve, 3200));
  assert.equal(infos.length, 9, "窗口到点补发聚合条");
  assert.match(infos[8], /另有 1 个任务已完成/, "聚合条文案带计数");
  assert.match(infos[8], /并行任务B/, "聚合条带最近标题");
}

// 错误合并窗口过期后通知并携带合并计数
{
  const infos = [];
  const mergeCfg = join(work, "merge.json");
  writeFileSync(mergeCfg, JSON.stringify({ errorMergeWindowMs: 20 }));
  const { ctx, listeners } = makeFakeCtx({ logger: { warn: () => {}, info: (t) => infos.push(t) } });
  await apply(ctx, { enabled: true, configFile: mergeCfg, toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });
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
  const { ctx, listeners } = makeFakeCtx({ logger: { warn: () => {}, info: (t) => infos.push(t) } });
  await apply(ctx, { enabled: true, configFile: cfg0, toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });
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

  // 默认关：子代理完成不通知，主任务完成不受影响
  {
    const infos = [];
    const { ctx, listeners } = makeFakeCtx({ logger: { warn: () => {}, info: (t) => infos.push(t) } });
    await apply(ctx, { enabled: true, configFile: subCfg, toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });
    const status = listeners.get("agent/status")[0];
    status({ agent: agentWithTitle("sub-1", "子任务A", { depth: 1, turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("sub-1", "子任务A", { depth: 1, turnEnd: 1 }), status: "idle" });
    assert.equal(infos.length, 0, "notifySubagentDone 默认关：子代理完成不通知");
    status({ agent: agentWithTitle("main-1", "主任务", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("main-1", "主任务", { turnEnd: 1 }), status: "idle" });
    assert.equal(infos.length, 1, "主任务完成不受子代理开关影响");
    assert.match(infos[0], /done/);
  }

  // 开启 notifySubagentDone：子代理完成用独立事件类型 subagent-done（标题/耗时）
  {
    const infos = [];
    writeFileSync(subCfg, JSON.stringify({ notifySubagentDone: true }));
    const { ctx, listeners } = makeFakeCtx({ logger: { warn: () => {}, info: (t) => infos.push(t) } });
    await apply(ctx, { enabled: true, configFile: subCfg, toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });
    const status = listeners.get("agent/status")[0];
    status({ agent: agentWithTitle("sub-2", "子任务B", { depth: 1, turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("sub-2", "子任务B", { depth: 1, turnEnd: 1 }), status: "idle" });
    assert.equal(infos.length, 1);
    assert.match(infos[0], /subagent-done/, "子代理完成用独立事件类型");
    assert.match(infos[0], /子任务「子任务B」已完成/, "subagent-done 文案带任务标题");
    assert.match(infos[0], /耗时：/, "subagent-done 带耗时");
    assert.ok(!infos[0].includes("sub-2"), "子代理完成通知不暴露会话 id");
    // 等 subagent-done 的 3s 聚合窗口结束（否则主任务完成会被聚合挂起）
    await new Promise((resolve) => setTimeout(resolve, 3200));
    status({ agent: agentWithTitle("main-2", "主任务2", { turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("main-2", "主任务2", { turnEnd: 1 }), status: "idle" });
    assert.equal(infos.length, 2, "主任务仍走 done 类型");
    assert.match(infos[1], /done/);
  }

  // S2 回归：notifyTaskDone=false + notifySubagentDone=true 时子代理完成仍通知
  {
    const infos = [];
    writeFileSync(subCfg, JSON.stringify({ notifyTaskDone: false, notifySubagentDone: true }));
    const { ctx, listeners } = makeFakeCtx({ logger: { warn: () => {}, info: (t) => infos.push(t) } });
    await apply(ctx, { enabled: true, configFile: subCfg, toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });
    const status = listeners.get("agent/status")[0];
    status({ agent: agentWithTitle("sub-3", "子任务C", { depth: 1, turnEnd: 1 }), status: "running" });
    status({ agent: agentWithTitle("sub-3", "子任务C", { depth: 1, turnEnd: 1 }), status: "idle" });
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

// 中断抑制：用户停止生成/中断（turn/end reason aborted）固定静默；
// S1：本轮 idle 未闭合新 turn/end 时宁可静默（覆盖 abort 早于 turn/start 的窗口）
{
  const infos = [];
  const { ctx, listeners } = makeFakeCtx({ logger: { warn: () => {}, info: (t) => infos.push(t) } });
  await apply(ctx, { enabled: true, configFile: join(work, "interrupt.json"), toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });
  const status = listeners.get("agent/status")[0];

  // 用户停止生成（turn/end aborted）：不通知完成
  status({ agent: agentWithTitle("int-1", "被打断的任务", { turnEnd: 1, turnEndKind: "aborted" }), status: "running" });
  status({ agent: agentWithTitle("int-1", "被打断的任务", { turnEnd: 1, turnEndKind: "aborted" }), status: "idle" });
  assert.equal(infos.length, 0, "中断（turn/end aborted）不通知完成");

  // S1：abort 早于本轮 turn/start 落盘——本轮无新 turn/end，读到的还是
  // 上一次的 completed → 必须静默（不能误报完成）
  status({ agent: agentWithTitle("s1-1", "任务S1", { turnEnd: 1 }), status: "running" });
  status({ agent: agentWithTitle("s1-1", "任务S1", { turnEnd: 1 }), status: "idle" });
  assert.equal(infos.length, 1, "正常完成一轮");
  assert.match(infos[0], /done/);
  // 第二轮被提前中断：events 无新 turn/end（仍停在 turn=1 completed），idle 照发 → 静默
  status({ agent: agentWithTitle("s1-1", "任务S1", { turnEnd: 1 }), status: "running" });
  status({ agent: agentWithTitle("s1-1", "任务S1", { turnEnd: 1 }), status: "idle" });
  assert.equal(infos.length, 1, "S1：本轮无新 turn/end closure 宁可静默");

  // 全新 agent 从未跑完一轮即 idle（首建即中断）：无 turn/end → 静默
  status({ agent: agentWithTitle("s1-2", "首建即中断"), status: "running" });
  status({ agent: agentWithTitle("s1-2", "首建即中断"), status: "idle" });
  assert.equal(infos.length, 1, "S1：无 turn/end 静默");

  // 中断后继续：新一轮 turn/end completed（turn 号递增）正常通知
  // （先等 s1-1 场景的 3s 完成聚合窗口结束，避免本轮完成被并入旧窗口挂起）
  await new Promise((resolve) => setTimeout(resolve, 3200));
  status({ agent: agentWithTitle("int-2", "中断后继续", { turnEnd: 1, turnEndKind: "aborted" }), status: "running" });
  status({ agent: agentWithTitle("int-2", "中断后继续", { turnEnd: 1, turnEndKind: "aborted" }), status: "idle" });
  assert.equal(infos.length, 1, "中断静默");
  status({ agent: agentWithTitle("int-2", "中断后继续", { turnEnd: 2 }), status: "running" });
  status({ agent: agentWithTitle("int-2", "中断后继续", { turnEnd: 2 }), status: "idle" });
  assert.equal(infos.length, 2, "中断后新一轮完成正常通知");
  assert.match(infos[1], /done/);

  // 子代理被中断（interrupt_agent → 子代理 turn/end aborted）：同样静默
  status({ agent: agentWithTitle("int-3", "子代理中断", { depth: 1, turnEnd: 1, turnEndKind: "aborted" }), status: "running" });
  status({ agent: agentWithTitle("int-3", "子代理中断", { depth: 1, turnEnd: 1, turnEndKind: "aborted" }), status: "idle" });
  assert.equal(infos.length, 2, "子代理中断不通知");

  // 任务失败（turn/end reason error）：idle 不得误报「任务完成」——
  // 失败由 agent/error 单独负责「任务出错」，同一轮不得叠加「完成」。
  status({ agent: agentWithTitle("err-1", "失败的任务", { turnEnd: 1, turnEndKind: "error" }), status: "running" });
  status({ agent: agentWithTitle("err-1", "失败的任务", { turnEnd: 1, turnEndKind: "error" }), status: "idle" });
  assert.equal(infos.length, 2, "失败（turn/end error）不通知完成");

  // 任务被阻塞（turn/end reason blocked，如等待用户问题）：idle 也不得误报完成
  status({ agent: agentWithTitle("blk-1", "被阻塞的任务", { turnEnd: 1, turnEndKind: "blocked" }), status: "running" });
  status({ agent: agentWithTitle("blk-1", "被阻塞的任务", { turnEnd: 1, turnEndKind: "blocked" }), status: "idle" });
  assert.equal(infos.length, 2, "阻塞（turn/end blocked）不通知完成");

  // 失败后继续：新一轮 turn/end completed（turn 号递增）正常通知
  // （先等 int-2 完成聚合窗口结束，避免本轮完成被并入旧窗口挂起）
  await new Promise((resolve) => setTimeout(resolve, 3200));
  status({ agent: agentWithTitle("err-2", "失败后继续", { turnEnd: 1, turnEndKind: "error" }), status: "running" });
  status({ agent: agentWithTitle("err-2", "失败后继续", { turnEnd: 1, turnEndKind: "error" }), status: "idle" });
  assert.equal(infos.length, 2, "失败静默");
  status({ agent: agentWithTitle("err-2", "失败后继续", { turnEnd: 2 }), status: "running" });
  status({ agent: agentWithTitle("err-2", "失败后继续", { turnEnd: 2 }), status: "idle" });
  assert.equal(infos.length, 3, "失败后新一轮完成正常通知");
  assert.match(infos[2], /done/);

  // max-tokens：模型输出被截断（答案不完整）——白名单判定「不通知完成」
  status({ agent: agentWithTitle("mt-1", "截断的任务", { turnEnd: 1, turnEndKind: "max-tokens" }), status: "running" });
  status({ agent: agentWithTitle("mt-1", "截断的任务", { turnEnd: 1, turnEndKind: "max-tokens" }), status: "idle" });
  assert.equal(infos.length, 3, "max-tokens 不通知完成");
  // 未知 kind（未来扩展）：白名单对齐 DSH 保守语义，同样静默
  status({ agent: agentWithTitle("uk-1", "未知结束", { turnEnd: 1, turnEndKind: "mystery-kind" }), status: "running" });
  status({ agent: agentWithTitle("uk-1", "未知结束", { turnEnd: 1, turnEndKind: "mystery-kind" }), status: "idle" });
  assert.equal(infos.length, 3, "未知 kind 不通知完成");
}

// notifyAsk=false（configFile）时 approval/request 不通知、不短路
{
  const infos = [];
  const askOffCfg = join(work, "ask-off.json");
  writeFileSync(askOffCfg, JSON.stringify({ notifyAsk: false }));
  const { ctx, listeners } = makeFakeCtx({ logger: { warn: () => {}, info: (t) => infos.push(t) } });
  await apply(ctx, { enabled: true, configFile: askOffCfg, toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });
  const approval = listeners.get("approval/request")[0];
  const outcome = await approval({ toolName: "bash", agent: { id: "session-1" } }, async () => "allowed-once");
  assert.equal(outcome, "allowed-once", "不短路");
  assert.equal(infos.length, 0, "notifyAsk=false 不通知");
}

// M4 免打扰紧急例外：allowKinds 中的 kind 在免打扰时段仍通知
{
  const qhCfg = join(work, "qh-allow.json");
  const qhOn = { enabled: true, start: "00:00", end: "23:59" };
  writeFileSync(qhCfg, JSON.stringify({ quietHours: { ...qhOn, allowKinds: ["ask"] } }));
  const infos = [];
  const { ctx, listeners } = makeFakeCtx({ logger: { warn: () => {}, info: (t) => infos.push(t) } });
  await apply(ctx, { enabled: true, configFile: qhCfg, toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });
  const approval = listeners.get("approval/request")[0];
  await approval({ toolName: "pwsh", agent: agentWithTitle("qh-1", "免打扰审批", { turnEnd: 1 }) }, async () => "ok");
  assert.equal(infos.length, 1, "免打扰期间 ask 仍通知（紧急例外 allowKinds）");
  assert.match(infos[0], /ask/);

  // allowKinds 为空/不含 ask：免打扰生效则静默
  writeFileSync(qhCfg, JSON.stringify({ quietHours: { ...qhOn, allowKinds: [] } }));
  const infos2 = [];
  const { ctx: ctx2, listeners: listeners2 } = makeFakeCtx({ logger: { warn: () => {}, info: (t) => infos2.push(t) } });
  await apply(ctx2, { enabled: true, configFile: qhCfg, toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });
  await listeners2.get("approval/request")[0]({ toolName: "pwsh", agent: { id: "qh-2" } }, async () => "ok");
  assert.equal(infos2.filter((t) => !t.includes("被免打扰拦截")).length, 0, "无 allowKinds 时免打扰不产生实际通知");
  assert.ok(infos2.some((t) => t.includes("被免打扰拦截")), "被拦截仍记录日志（可核对发没发）");
}

// 用户提问通知：包装 ctx.userQuestions.ask（internal/service 事件 + 热重载解包重包）
{
  const infos = [];
  let fakeService = null;
  const { ctx, listeners } = makeFakeCtx({
    logger: { warn: () => {}, info: (t) => infos.push(t) },
    get: (name) => (name === "userQuestions" ? fakeService : undefined),
  });
  await apply(ctx, { enabled: true, configFile: join(work, "question.json"), toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });

  // 启动时 service 未注册 → 不包装；internal/service 事件到达后包装
  const serviceHandler = listeners.get("internal/service")[0];
  assert.ok(serviceHandler, "internal/service 监听器已注册");
  // 依赖 this 的类方法风格：验证包装后 this 仍绑定 service 实例（bind 回归测试）
  fakeService = {
    marker: "svc-marker",
    ask: async function (request) {
      return { answers: [this.marker] };
    },
  };
  serviceHandler("userQuestions", fakeService);

  const agent = { id: "session-1", session: { events: [{ type: "session/title", data: { title: "提问测试" } }] } };
  const result = await fakeService.ask({ agent, questions: [{ question: "今天吃了吗？" }] });
  assert.deepEqual(result, { answers: ["svc-marker"] }, "包装不改变原 ask 返回值，且 this 正确绑定");
  assert.ok(infos.some((t) => /question/.test(t)), "提问触发通知");
  assert.ok(infos.some((t) => /任务「提问测试」需要你回答/.test(t)), "提问通知带任务标题");
  assert.ok(infos.some((t) => /问题：今天吃了吗？/.test(t)), "提问通知带问题摘要");
  assert.ok(infos.some((t) => !t.includes("session-1")), "提问通知不暴露会话 id");

  // 热重载安全：重复触发 internal/service 时解包重包（不叠层、不重复通知）
  const askRef = fakeService.ask;
  serviceHandler("userQuestions", fakeService);
  assert.notEqual(fakeService.ask, askRef, "重复注册重新包装（解包旧包装）");
  const infoCountBefore = infos.length;
  const result2 = await fakeService.ask({ agent, questions: [{ question: "再问一次？" }] });
  assert.deepEqual(result2, { answers: ["svc-marker"] }, "解包重包后 ask 返回值不变，this 绑定正确");
  assert.equal(infos.length, infoCountBefore + 1, "解包重包不叠层，通知只发一次");

  // notifyQuestion=false 不通知（用独立的 service 实例，避免闭包捕获上一实例的配置）
  writeFileSync(join(work, "question-off.json"), JSON.stringify({ notifyQuestion: false }));
  let fakeService2 = null;
  const { ctx: ctx2, listeners: listeners2 } = makeFakeCtx({
    logger: { warn: () => {}, info: (t) => infos.push(t) },
    get: (name) => (name === "userQuestions" ? fakeService2 : undefined),
  });
  await apply(ctx2, { enabled: true, configFile: join(work, "question-off.json"), toastScript: join(work, "toast.ps1"), historyFile: join(work, "history.jsonl") });
  const serviceHandler2 = listeners2.get("internal/service")[0];
  fakeService2 = { ask: async (request) => ({ answers: [] }) };
  serviceHandler2("userQuestions", fakeService2);
  const before = infos.length;
  await fakeService2.ask({ agent: { id: "session-2" }, questions: [{ question: "hi" }] });
  assert.equal(infos.length, before, "notifyQuestion=false 不通知");
}

// 开启 notifyTurnEnd 后 turn-stopping 通知(配置经 configFile 生效,apply 参数不接收通知开关)
{
  const infos = [];
  const turnEndCfg = join(work, "notify-turn-end.json");
  writeFileSync(turnEndCfg, JSON.stringify({ notifyTurnEnd: true }));
  const { ctx, listeners } = makeFakeCtx({ logger: { warn: () => {}, info: (t) => infos.push(t) } });
  await apply(ctx, {
    enabled: true,
    configFile: turnEndCfg,
    toastScript: join(work, "toast.ps1"),
  });
  const turnStop = listeners.get("agent/turn-stopping")[0];
  assert.ok(turnStop, "turn-stopping 监听器已注册");
  await turnStop({ agent: { id: "session-1", session: { events: [{ type: "session/title", data: { title: "优化 notifier 插件" } }] } }, turn: 4 });
  assert.ok(infos.some((t) => /turn-end/.test(t)), "notifyTurnEnd 开启后 turn-stopping 触发通知");
  assert.ok(infos.some((t) => /任务「优化 notifier 插件」第 4 轮工作已完成/.test(t)), "轮次完成通知带任务标题与轮次号");
  assert.ok(infos.some((t) => !t.includes("session-1")), "轮次完成通知不暴露会话 id");
  const countAfterFirst = infos.filter((t) => t.includes("turn-end")).length;
  // 同轮重复 emit（模拟事件被反复触发/热重载叠加）不重复通知——防「日志一堆」
  await turnStop({ agent: { id: "session-1", session: { events: [{ type: "session/title", data: { title: "优化 notifier 插件" } }] } }, turn: 4 });
  await turnStop({ agent: { id: "session-1", session: { events: [{ type: "session/title", data: { title: "优化 notifier 插件" } }] } }, turn: 4 });
  assert.equal(infos.filter((t) => t.includes("turn-end")).length, countAfterFirst, "同一 (agent,turn) 重复 turn-stopping 只通知一次");
  // 新的一轮（turn 5）仍正常通知
  await turnStop({ agent: { id: "session-1", session: { events: [{ type: "session/title", data: { title: "优化 notifier 插件" } }] } }, turn: 5 });
  assert.equal(infos.filter((t) => t.includes("turn-end")).length, countAfterFirst + 1, "新轮次仍正常通知");
}

// ---------------------------------------------------------------- 路由

{
  const { routes } = await makeNotifier();
  const configRoute = routes.find((r) => r.path === ROUTES.config);
  const eventsRoute = routes.find((r) => r.path === ROUTES.events);
  const testRoute = routes.find((r) => r.path === ROUTES.test);
  const historyRoute = routes.find((r) => r.path === ROUTES.history);
  assert.ok(configRoute && eventsRoute && testRoute && historyRoute, "四条路由已注册");

  // 403
  for (const route of [configRoute, eventsRoute, testRoute, historyRoute]) {
    const { rec, res } = makeRes();
    await route.handler(fakeReq({ socket: { remoteAddress: "10.0.0.2" } }), res);
    assert.equal(rec.status, 403);
  }

  // 405：test 路由仅 POST；history 路由仅 GET
  {
    const { rec, res } = makeRes();
    await testRoute.handler(fakeReq({}), res);
    assert.equal(rec.status, 405);
    const { rec: rec2, res: res2 } = makeRes();
    await historyRoute.handler(fakeReq({ method: "POST" }), res2);
    assert.equal(rec2.status, 405);
  }

  // config GET：默认值
  {
    const { rec, res } = makeRes();
    await configRoute.handler(fakeReq({}), res);
    assert.equal(rec.status, 200);
    assert.equal(JSON.parse(rec.text).notifyAsk, true);
  }

  // config PUT：持久化 + 内存生效
  {
    function bodyReq(payload) {
      const text = JSON.stringify(payload);
      return {
        method: "PUT",
        url: "/",
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
        on(event, cb) {
          if (event === "data") setTimeout(() => cb(Buffer.from(text)), 0);
          else if (event === "end") setTimeout(cb, 1);
          return this;
        },
        destroy() {},
      };
    }
    const { rec, res } = makeRes();
    await configRoute.handler(bodyReq({ notifyAsk: false, quietHours: { enabled: true, start: "23:00", end: "07:00" } }), res);
    assert.equal(rec.status, 200);
    assert.equal(JSON.parse(rec.text).notifyAsk, false);
    const stored = JSON.parse(readFileSync(storeFile, "utf8"));
    assert.equal(stored.notifyAsk, false);
    assert.equal(stored.quietHours.start, "23:00");

    // GET 反映新值
    const { rec: rec2, res: res2 } = makeRes();
    await configRoute.handler(fakeReq({}), res2);
    assert.equal(JSON.parse(rec2.text).notifyAsk, false);
  }

  // config PUT 容错：非法 JSON → 400；超大 body → 不挂起、无未处理拒绝
  {
    function rawBodyReq(text) {
      return {
        method: "PUT",
        url: "/",
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:3080", "sec-fetch-site": "same-origin" },
        on(event, cb) {
          if (event === "data") setTimeout(() => cb(Buffer.from(text)), 0);
          else if (event === "end") setTimeout(cb, 1);
          return this;
        },
        destroy() {},
      };
    }
    const { rec, res } = makeRes();
    await configRoute.handler(rawBodyReq("{ not json"), res);
    assert.equal(rec.status, 400, "非法 JSON 返回 400 可读错误");
    const { rec: rec2, res: res2 } = makeRes();
    await configRoute.handler(rawBodyReq('{"big":"' + "x".repeat(20 * 1024) + '"}'), res2);
    assert.equal(rec2.status, 0, "超大 body：连接被 destroy、handler 无响应但不挂起不抛错");
  }

  // events SSE
  {
    const { rec, res } = makeRes();
    await eventsRoute.handler(fakeReq({}), res);
    assert.equal(rec.status, 200);
    assert.equal(rec.headers["content-type"], "text/event-stream");
    assert.match(rec.text, /connected/);
  }

  // test：POST 触发通知广播到已连接的 SSE 客户端
  {
    const { rec: rec1, res: res1 } = makeRes();
    await eventsRoute.handler(fakeReq({}), res1);
    const { rec: rec2, res: res2 } = makeRes();
    const testReq = fakeReq({ method: "POST" });
    await testRoute.handler(testReq, res2);
    assert.equal(rec2.status, 200);
    assert.equal(JSON.parse(rec2.text).ok, true);
    assert.match(rec1.text, /测试通知/, "SSE 客户端收到测试通知帧");
    assert.match(rec1.text, /"kind":"test"/, "测试帧带 kind=test 标记");
    assert.match(rec1.text, /"seq":\d+/, "通知帧带递增 seq");
  }

  // events ?since 回放（独立上下文，seq 从 1 起）：断线补拉不丢尾部事件
  {
    const { routes: routes2 } = await makeNotifier();
    const eventsRoute2 = routes2.find((r) => r.path === ROUTES.events);
    const testRoute2 = routes2.find((r) => r.path === ROUTES.test);
    await testRoute2.handler(fakeReq({ method: "POST" }), makeRes().res); // seq=1
    await testRoute2.handler(fakeReq({ method: "POST" }), makeRes().res); // seq=2
    // since=1 的连接：只回放 seq=2
    const { rec, res } = makeRes();
    await eventsRoute2.handler(fakeReq({ url: "/api/dsh-notifier/events?since=1" }), res);
    const notifyFrames = rec.text.split("data: ").filter((s: string) => s.includes('"type":"notify"'));
    assert.equal(notifyFrames.length, 1, "since=1 只回放 1 条");
    assert.match(notifyFrames[0], /"seq":2/, "回放帧带正确 seq");
    // since 超出缓冲 → 无回放，仅 connected 注释
    const { rec: rec3, res: res3 } = makeRes();
    await eventsRoute2.handler(fakeReq({ url: "/api/dsh-notifier/events?since=99" }), res3);
    assert.ok(!rec3.text.includes('"type":"notify"'), "since 超出无回放");
    // 非法 since 静默回退为 0
    const { rec: rec4, res: res4 } = makeRes();
    await eventsRoute2.handler(fakeReq({ url: "/api/dsh-notifier/events?since=abc" }), res4);
    assert.ok(!rec4.text.includes('"type":"notify"'), "非法 since 按 0 处理");
  }

  // history：测试通知已落盘，GET 可查
  {
    // appendHistory 是 fire-and-forget，等一拍再查
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { rec, res } = makeRes();
    await historyRoute.handler(fakeReq({}), res);
    assert.equal(rec.status, 200);
    const records = JSON.parse(rec.text).records;
    assert.ok(Array.isArray(records) && records.length >= 1, "历史记录非空");
    assert.equal(records[records.length - 1].kind, "test", "最近一条为测试通知");
    assert.match(records[records.length - 1].message, /通知链路工作正常/, "记录含测试文案");
  }

  // 并发历史写入：写队列串行化，不丢记录（模拟真实多事件同时触发）
  {
    const concurrent = 20;
    await Promise.all(Array.from({ length: concurrent }, async () => {
      const { rec, res } = makeRes();
      await testRoute.handler(fakeReq({ method: "POST" }), res);
      assert.equal(rec.status, 200);
    }));
    await new Promise((resolve) => setTimeout(resolve, 300)); // 等写队列排空
    const { rec, res } = makeRes();
    await historyRoute.handler(fakeReq({}), res);
    const records = JSON.parse(rec.text).records;
    const testCount = records.filter((r) => r.kind === "test").length;
    assert.ok(testCount >= concurrent, `并发写不丢记录（test 记录 ${testCount} ≥ ${concurrent}）`);
  }
}

// history：DELETE 清空 + historyMaxAgeDays 按天清理（独立上下文，隔离其他用例）
{
  const hfile = join(work, "history-clean.jsonl");
  const hcfg = join(work, "history-clean-cfg.json");
  writeFileSync(hcfg, JSON.stringify({ historyMaxAgeDays: 7 }));
  // 预置一条 10 天前的旧记录
  writeFileSync(hfile, JSON.stringify({ ts: Date.now() - 10 * 86400000, kind: "done", title: "旧记录", message: "10 天前" }) + "\n");
  const { routes } = await makeNotifier({ historyFile: hfile, configFile: hcfg });
  const h = routes.find((r) => r.path === ROUTES.history);
  const t = routes.find((r) => r.path === ROUTES.test);
  // 触发一条新通知（test 路由 → 落盘；写时会按 7 天 cutoff 剔除旧行）
  await t.handler(fakeReq({ method: "POST" }), makeRes().res);
  await new Promise((resolve) => setTimeout(resolve, 80)); // 等写队列排空
  const { rec: recGet, res: resGet } = makeRes();
  await h.handler(fakeReq({}), resGet);
  const records = JSON.parse(recGet.text).records;
  assert.equal(records.length, 1, "historyMaxAgeDays=7：10 天前旧记录被清理，只留新记录");
  assert.equal(records[0].kind, "test", "保留的是新记录");
  // DELETE 清空
  const { rec: recDel, res: resDel } = makeRes();
  await h.handler(fakeReq({ method: "DELETE" }), resDel);
  const del = JSON.parse(recDel.text);
  assert.equal(del.ok, true);
  assert.ok(del.removed >= 1, "DELETE 返回被清空条数");
  const { rec: recEmpty, res: resEmpty } = makeRes();
  await h.handler(fakeReq({}), resEmpty);
  assert.equal(JSON.parse(recEmpty.text).records.length, 0, "清空后 GET 为空");
}

// ---------------------------------------------------------------- 两端路由一致性

{
  const client = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
  // 客户端契约（共享 smoke-lib：源形态 + 执行契约，与 contract-check 同源）
  assertClientSourceContract(pkgDir);
  assertClientProductContract(pkgDir);
  const literals = [...client.matchAll(/\/api\/dsh-notifier\/[a-z-]+/g)].map((m) => m[0]);
  const expected = Object.values(ROUTES);
  for (const literal of literals) assert.ok(expected.includes(literal), `client 出现未知路由: ${literal}`);
  for (const route of expected) assert.ok(literals.includes(route), `client 缺少路由: ${route}`);
}

rmSync(work, { recursive: true, force: true });

console.log("dsh-notifier smoke: OK");
