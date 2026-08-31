// @ts-nocheck
/**
 * dsh-notifier — 通知中心 service 契约测试（M1，issue #366）。
 *
 * 直接构造 createNotifierService 的 deps（fake sse/system/history/logger），
 * 聚焦 service 自身契约（不经完整 apply，速度快且隔离）：
 * - 内置事件源 → severity 映射静态表（评审 #1 契约）
 * - send() 受理语义：enabled=false / 非法形状 / 内置 kind 走文案管线
 * - 动态 kind 待确认：未确认 → suppressed 落史；confirmKind 后放行
 * - registerKind 防冒认（前缀为内置 kind 名拒绝；无 ':' 拒绝）
 * - fail-soft 逐频道投递：单频道抛错不牵连
 */
import assert from "node:assert/strict";
import { createNotifierService, KIND_SEVERITY, BUILTIN_CHANNELS } from "../lib/index.js";

// ---------------------------------------------------------------- fake deps

/** fake SSE hub（记录 broadcast 帧）。 */
function fakeSse() {
  const frames = [];
  return {
    frames,
    broadcast(payload) {
      frames.push(payload);
    },
    register() {},
    framesSince() {
      return [];
    },
    size: () => 0,
    dispose() {},
  };
}

/** fake system notifier（记录调用）。 */
function fakeSystem() {
  const calls = [];
  return {
    calls,
    notify(title, message) {
      calls.push({ title, message });
    },
  };
}

/** fake history（记录 append）。 */
function fakeHistory() {
  const entries = [];
  return {
    entries,
    append(e) {
      entries.push(e);
    },
    read: async () => entries,
    clear: async () => {
      entries.length = 0;
      return 0;
    },
  };
}

/** 构造一个配置镜像（默认全开）。 */
function defaultCfg(overrides = {}) {
  return {
    notifyAsk: true,
    notifyQuestion: true,
    notifyTaskDone: true,
    notifySubagentDone: false,
    notifyTaskError: true,
    notifyTurnEnd: false,
    systemNotify: true,
    browserNotify: true,
    notifyWhenVisible: false,
    notifySound: true,
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
    errorMergeWindowMs: 60000,
    askRemindMin: 5,
    doneMergeWindowMs: 3000,
    historyMaxAgeDays: 0,
    maxConnections: 16,
    ...overrides,
  };
}

/** 完整 deps 装配。 */
function makeService(cfgOverrides = {}, hooks = {}) {
  const sse = fakeSse();
  const system = fakeSystem();
  const history = fakeHistory();
  const cfg = defaultCfg(cfgOverrides);
  const logger = { warn: hooks.warn ?? (() => {}), info: hooks.info ?? (() => {}) };
  const enabled = hooks.enabled ?? (() => true);
  const service = createNotifierService({
    current: () => cfg,
    enabled,
    sse,
    system,
    history,
    logger,
  });
  return { service, sse, system, history };
}

// ---------------------------------------------------------------- ① severity 映射

{
  const title = "① severity 静态映射覆盖内置七 kind";
  const expected = {
    ask: "warning",
    question: "info",
    done: "success",
    "subagent-done": "info",
    error: "failure",
    "turn-end": "info",
    test: "info",
  };
  for (const [kind, severity] of Object.entries(expected)) {
    assert.equal(KIND_SEVERITY[kind], severity, `${kind} → ${severity}`);
  }
  console.log(`${title}: OK（7 项）`);
}

// ---------------------------------------------------------------- ② send 受理语义

{
  // enabled=false → skipped
  const { service } = makeService({}, { enabled: () => false });
  const r = await service.send({ source: "test", kind: "done", severity: "info", body: "x" });
  assert.equal(r[0].status, "skipped");
  assert.equal(r[0].error, "enabled=false");
  console.log("②a enabled=false → skipped: OK");
}

{
  // 非法形状 → failed（不抛异常）
  const { service } = makeService();
  const r = await service.send(null);
  assert.equal(r[0].status, "failed");
  const r2 = await service.send({ source: "test", severity: "info", body: "x" });
  assert.equal(r2[0].status, "failed");
  console.log("②b 非法形状 → failed（不抛）: OK");
}

{
  // 内置 kind：经文案管线（NOTIFY_KINDS 模板）→ browser 收到帧 + 历史落盘
  const { service, sse, history } = makeService();
  const r = await service.send({ source: "test", kind: "done", severity: "info", body: "任务完成" });
  assert.ok(r.some((x) => x.channelId === "browser" && x.status === "ok"));
  // 内置 kind 走模板：消息含「已完成」而非 body 原样透传（评审 #1 保留文案模板）
  const frame = sse.frames.find((f) => f.type === "notify" && f.kind === "done");
  assert.ok(frame !== undefined, "browser 收到 done 帧");
  assert.ok(typeof frame.message === "string" && frame.message.includes("已完成"), `模板产物：${frame.message}`);
  assert.ok(history.entries.some((e) => e.kind === "done"));
  console.log("②c 内置 kind 走文案管线 + 历史落盘: OK");
}

// ---------------------------------------------------------------- ③ 动态 kind 待确认

{
  // 未确认 → suppressed 落史，零触达
  const { service, sse, history } = makeService();
  service.registerKind({ id: "idle-archive:due", label: "会话闲置待归档" });
  const r = await service.send({ source: "@wingsky-1/dsh-idle-archive", kind: "idle-archive:due", severity: "info", body: "3 个会话闲置" });
  assert.equal(r[0].status, "skipped");
  assert.equal(r[0].error, "kind-pending");
  assert.equal(sse.frames.length, 0, "待确认 kind 不得触达频道");
  assert.ok(history.entries.some((e) => e.suppressed === "kind-pending"));
  console.log("③a 待确认 → suppressed 落史零触达: OK");
}

{
  // confirmKind 后放行
  const { service, sse } = makeService();
  service.registerKind({ id: "idle-archive:due", label: "会话闲置待归档" });
  service.confirmKind("idle-archive:due", true);
  const r = await service.send({ source: "@wingsky-1/dsh-idle-archive", kind: "idle-archive:due", severity: "info", body: "3 个会话闲置" });
  assert.ok(r.some((x) => x.status === "ok"));
  assert.ok(sse.frames.some((f) => f.kind === "idle-archive:due"));
  console.log("③b confirmKind 后放行: OK");
}

{
  // listKinds 反映确认态
  const { service } = makeService();
  service.registerKind({ id: "x:y", label: "Y" });
  const before = service.listKinds();
  assert.equal(before[0].confirmed, false);
  service.confirmKind("x:y", true);
  assert.equal(service.listKinds()[0].confirmed, true);
  console.log("③c listKinds 反映确认态: OK");
}

// ---------------------------------------------------------------- ④ registerKind 防冒认

{
  const { service } = makeService();
  // 无 ':' 前缀拒绝
  service.registerKind({ id: "naked", label: "N" });
  assert.equal(service.listKinds().length, 0);
  // 前缀为内置 kind 名拒绝
  service.registerKind({ id: "done:extra", label: "D" });
  assert.equal(service.listKinds().length, 0);
  // 合法动态 id 接受
  service.registerKind({ id: "idle-archive:due", label: "D" });
  assert.equal(service.listKinds().length, 1);
  console.log("④ registerKind 防冒认: OK");
}

// ---------------------------------------------------------------- ⑤ fail-soft 逐频道

{
  // 关闭 browser、只留 system：dispatch 只走 system
  const { service, sse } = makeService({ browserNotify: false, systemNotify: true });
  const r = await service.send({ source: "test", kind: "error", severity: "failure", body: "boom" });
  assert.ok(r.some((x) => x.channelId === "system" && x.status === "ok"));
  assert.ok(!r.some((x) => x.channelId === "browser"));
  assert.equal(sse.frames.length, 0, "browser 关闭时不投递");
  console.log("⑤ 频道开关路由生效（browser 关 → 只走 system）: OK");
}

console.log("dsh-notifier service contract: OK");
