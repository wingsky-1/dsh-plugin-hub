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
import { createNotifierService, KIND_SEVERITY, BUILTIN_CHANNELS, createBarkChannel, createBarkGate, SEVERITY_LEVEL } from "../lib/index.js";

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
    channels: [],
    kindRoutes: {},
    allowKinds: [],
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
  /** 投递终态收集（M2：recordStatus/emitSent 断言用）。 */
  const terminalStates = [];
  const sentEvents = [];
  /** 确认写入收集（M2：confirmKind 走配置）。 */
  const confirmCalls = [];
  const service = createNotifierService({
    current: () => cfg,
    enabled,
    sse,
    system,
    history,
    logger,
    outboundChannels: hooks.outboundChannels ?? (() => []),
    recordStatus: (channelId, status, error) => {
      terminalStates.push({ channelId, status, error });
      if (hooks.recordStatus) hooks.recordStatus(channelId, status, error);
    },
    emitSent: (payload) => {
      sentEvents.push(payload);
      if (hooks.emitSent) hooks.emitSent(payload);
    },
    setConfirm: (kind, confirmed) => {
      confirmCalls.push({ kind, confirmed });
      // 模拟配置写入生效（真实实现：settings update → watch → current 刷新）
      const allowed = new Set(Array.isArray(cfg.allowKinds) ? cfg.allowKinds : []);
      if (confirmed) allowed.add(kind);
      else allowed.delete(kind);
      cfg.allowKinds = [...allowed];
      if (hooks.setConfirm) hooks.setConfirm(kind, confirmed);
    },
  });
  return { service, sse, system, history, terminalStates, sentEvents, confirmCalls };
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
  service.registerKind({ id: "demo:ready", label: "示例事务就绪" });
  const r = await service.send({ source: "@example/demo-consumer", kind: "demo:ready", severity: "info", body: "3 个事务就绪" });
  assert.equal(r[0].status, "skipped");
  assert.equal(r[0].error, "kind-pending");
  assert.equal(sse.frames.length, 0, "待确认 kind 不得触达频道");
  assert.ok(history.entries.some((e) => e.suppressed === "kind-pending"));
  console.log("③a 待确认 → suppressed 落史零触达: OK");
}

{
  // confirmKind 后放行
  const { service, sse } = makeService();
  service.registerKind({ id: "demo:ready", label: "示例事务就绪" });
  service.confirmKind("demo:ready", true);
  const r = await service.send({ source: "@example/demo-consumer", kind: "demo:ready", severity: "info", body: "3 个事务就绪" });
  assert.ok(r.some((x) => x.status === "ok"));
  assert.ok(sse.frames.some((f) => f.kind === "demo:ready"));
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

// ---------------------------------------------------------------- fake 出站频道

/** fake 出站频道（bark 形态）：记录投递，可指定同步/异步终态。 */
function fakeOutbound(id, mode = "sync") {
  const sent = [];
  return {
    sent,
    entry: {
      id,
      channel: {
        name: id,
        capabilities: { titleMaxLen: 64, maxBodyLen: 256 },
        send(p) {
          sent.push(p);
          // 注意：凭据字面替换是 createBarkChannel 内部 scrub 的职责（⑥b 已验）；
          // 本 fake 验证 deliver 层统一出口（sanitizeErrorText + status/sent 上报）。
          if (mode === "reject") return Promise.reject(new Error("bark HTTP 400: device token lookup failed"));
          return Promise.resolve();
        },
      },
    },
  };
}

// ---------------------------------------------------------------- ⑥ bark 频道契约

{
  // severity→level 映射 + payload 形态 + 成功判定双查 + 透传
  const origFetch = globalThis.fetch;
  const calls = [];
  try {
    // URL 过滤：只拦截本块目标，避免污染/被污染（同进程其他在途 fetch 直通原始实现）
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("http://127.0.0.1:40280/")) return origFetch(url, init);
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ code: 200, message: "success" }), text: async () => "" };
    };
    // 映射表契约（评审 P0-2 锁定）
    assert.equal(SEVERITY_LEVEL.failure, "timeSensitive");
    assert.equal(SEVERITY_LEVEL.warning, "active");
    assert.equal(SEVERITY_LEVEL.success, "active");
    assert.equal(SEVERITY_LEVEL.info, "passive");

    const cfg = { id: "phone", type: "bark", baseUrl: "http://127.0.0.1:40280", deviceKey: "SECRETKEY22", enabled: true, sound: "minuet", group: "dsh", volume: "0.8" };
    const ch = createBarkChannel(cfg, createBarkGate());
    const p = ch.send({ title: "T", body: "B", kind: "error", ts: 123, severity: "failure" });
    assert.ok(p && typeof p.then === "function", "send 返回在途 promise");
    await p;
    assert.equal(calls[0].url, "http://127.0.0.1:40280/push", "POST baseUrl+/push；device key 不在 URL");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.device_key, "SECRETKEY22", "device_key 走 body");
    assert.equal(body.title, "T");
    assert.equal(body.body, "B");
    assert.equal(body.level, "timeSensitive", "failure → timeSensitive");
    assert.equal(body.sound, "minuet");
    assert.equal(body.group, "dsh");
    assert.equal(body.volume, "0.8", "未知参数透传（Bark 前向兼容）");
    await ch.send({ title: "T", body: "B", kind: "test", ts: 1, severity: "info" });
    assert.equal(JSON.parse(calls[1].init.body).level, "passive", "info → passive");
    const ch2 = createBarkChannel({ ...cfg, level: "critical" }, createBarkGate());
    await ch2.send({ title: "T", body: "B", kind: "error", ts: 2, severity: "failure" });
    assert.equal(JSON.parse(calls[2].init.body).level, "critical", "显式 level 覆盖映射");
  } finally {
    globalThis.fetch = origFetch;
  }
  console.log("⑥ bark payload/level 映射/透传: OK");
}

{
  // 失败路径：4xx 不重试且错误脱敏；5xx 重试 ×2 后成功
  const origFetch = globalThis.fetch;
  try {
    let n = 0;
    globalThis.fetch = async (url) => {
      if (!String(url).startsWith("https://h/")) return origFetch(url);
      n += 1;
      return { ok: false, status: 400, json: async () => ({}), text: async () => "failed to get [SECRETKEY22] device token from database" };
    };
    const ch = createBarkChannel({ id: "p", type: "bark", baseUrl: "https://h", deviceKey: "SECRETKEY22", enabled: true }, createBarkGate());
    let errText = "";
    await ch.send({ title: "T", body: "B", kind: "test", ts: 1 }).catch((e) => { errText = e.message; });
    assert.equal(n, 1, "4xx 确定失败不重试");
    assert.ok(errText.includes("device token"), "错误含响应摘要");
    assert.ok(!errText.includes("SECRETKEY22"), "错误文本无 device key 明文（评审 P0-4）");

    let attempts = 0;
    globalThis.fetch = async (url) => {
      if (!String(url).startsWith("https://h/")) return origFetch(url);
      attempts += 1;
      if (attempts <= 2) return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
      return { ok: true, status: 200, json: async () => ({ code: 200 }), text: async () => "" };
    };
    await ch.send({ title: "T", body: "B", kind: "test", ts: 2 });
    assert.equal(attempts, 3, "5xx 重试 ×2（1+2=3 次尝试）后成功");
  } finally {
    globalThis.fetch = origFetch;
  }
  console.log("⑥b bark 4xx 不重试+脱敏 / 5xx 重试: OK");
}

// ---------------------------------------------------------------- ⑦ 路由解析三条契约

{
  const phone = fakeOutbound("bark:phone");
  const pad = fakeOutbound("bark:pad");
  const chanCfg = [
    { id: "phone", type: "bark", baseUrl: "https://h", deviceKey: "k1", enabled: true },
    { id: "pad", type: "bark", baseUrl: "https://h", deviceKey: "k2", enabled: true },
  ];
  // 缺省广播：kindRoutes 无条目 → 内置 + 出站全收
  const svc1 = makeService({ channels: chanCfg }, { outboundChannels: () => [phone.entry, pad.entry] });
  const r1 = await svc1.service.send({ source: "t", kind: "error", severity: "failure", body: "x" });
  assert.ok(r1.some((x) => x.channelId === "bark:phone" && x.status === "ok"), "缺省广播含出站频道");
  assert.ok(r1.some((x) => x.channelId === "browser"), "缺省广播含内置频道");

  // 稀疏命中：条目只列 bark:phone → 只投该频道
  const svc2 = makeService({ channels: chanCfg, kindRoutes: { error: ["bark:phone"] } }, { outboundChannels: () => [phone.entry, pad.entry] });
  const r2 = await svc2.service.send({ source: "t", kind: "error", severity: "failure", body: "x" });
  assert.ok(r2.some((x) => x.channelId === "bark:phone" && x.status === "ok"));
  assert.ok(!r2.some((x) => x.channelId === "browser"), "稀疏条目排除未列频道");
  assert.ok(!r2.some((x) => x.channelId === "bark:pad"));

  // 陈旧路由：指向已删除频道 → skipped，不影响其他目标
  const svc3 = makeService({ channels: chanCfg, kindRoutes: { error: ["bark:gone", "bark:phone"] } }, { outboundChannels: () => [phone.entry] });
  const r3 = await svc3.service.send({ source: "t", kind: "error", severity: "failure", body: "x" });
  const staleEntry = r3.find((x) => x.channelId === "bark:gone");
  assert.ok(staleEntry, "陈旧频道有独立受理条目");
  assert.equal(staleEntry.status, "skipped");
  assert.equal(staleEntry.error, "stale-route");
  assert.ok(r3.some((x) => x.channelId === "bark:phone" && x.status === "ok"), "陈旧不影响其他目标");
  console.log("⑦ 路由解析（缺省广播/稀疏命中/陈旧 skipped）: OK");
}

// ---------------------------------------------------------------- ⑧ per-channel 测试 + 终态上报

{
  const phone = fakeOutbound("bark:phone");
  const bad = fakeOutbound("bark:bad", "reject");
  const svc = makeService(
    { channels: [{ id: "phone", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true }] },
    { outboundChannels: () => [phone.entry, bad.entry] },
  );
  // onlyChannel：单频道受理，内置频道排除
  const r = svc.service.sendKind("test", {}, { bypassQuiet: true, onlyChannel: "bark:phone" });
  assert.ok(r.some((x) => x.channelId === "bark:phone" && x.status === "ok"), "onlyChannel 命中单频道");
  assert.ok(!r.some((x) => x.channelId === "browser"), "per-channel 测试排除其他频道");
  // fake 频道终态经 promise 微任务回调——先 flush 再断言 status/sent
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(svc.terminalStates.some((s) => s.channelId === "bark:phone" && s.status === "ok"), "投递成功落 status");
  assert.ok(svc.sentEvents.some((e) => e.channelId === "bark:phone" && e.status === "ok" && e.kind === "test"), "投递成功发 sent 事件");
  // 异步终态失败：promise reject → status failed + 事件带脱敏错误
  const r2 = await svc.service.send({ source: "t", kind: "error", severity: "failure", body: "x" });
  assert.ok(r2.some((x) => x.channelId === "bark:bad" && x.status === "ok"), "受理与终态解耦（铁律 1）");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const badState = svc.terminalStates.find((s) => s.channelId === "bark:bad");
  assert.ok(badState, "异步失败落 status");
  assert.equal(badState.status, "failed");
  assert.ok(badState.error.includes("device token"), "失败摘要含响应信息（过 deliver 层 sanitizeErrorText）");
  const badEvent = svc.sentEvents.find((e) => e.channelId === "bark:bad");
  assert.ok(badEvent && badEvent.status === "failed" && badEvent.error, "sent 事件带失败终态");
  console.log("⑧ per-channel 测试 + 终态上报（status/sent）: OK");
}

console.log("dsh-notifier service contract: OK");
