// @ts-nocheck
/**
 * dsh-notifier — L2 interface 契约：pipeline 域注入面（N-14/N-15，PR2 T2-1）。
 *
 * 层间稳定性：域间经 pipeline/interface.ts 的交互契约——AdjudicateDeps
 * （current() 单刻快照恰好 1 次 / isKindConfirmed 收 (kind, snapshot) / 派生
 * 闭包不读 current）与 DeliverDeps（recordStatus/emitSent/appendHistory/play
 * 调用序列与参数 / fail-soft / 终态不持快照引用）。按 §11.2-1/2：只 import 本域
 * interface.ts + deps fake，不 import 其他域实现。
 *
 * 本文件为标准红测判别：createAdjudicator/createDeliverer 工厂落地前 import
 * 即红（改前红），工厂落地 + 单刻快照后全绿（改后绿）。
 */
import assert from "node:assert/strict";
import { createAdjudicator, createDeliverer } from "../src/pipeline/interface.ts";

/** 轮询直到谓词成立（替代固定 sleep：异步终态经 promise 微任务决议）。 */
async function pollUntil(predicate, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function baseCfg(overrides = {}) {
  return {
    browserNotify: true,
    systemNotify: true,
    browserSound: true,
    systemSound: true,
    quietHours: { enabled: false, start: "22:00", end: "08:00", allowKinds: [] },
    channels: [],
    kindRoutes: {},
    allowKinds: [],
    ...overrides,
  };
}

/** fake 频道（出站形态：send 记录调用）。 */
function fakeChannel(id, caps = { titleMaxLen: 64, maxBodyLen: 256 }) {
  const sent = [];
  return {
    name: id,
    capabilities: caps,
    sent,
    send(payload) {
      sent.push(payload);
      return undefined;
    },
  };
}

function quietWindowNow() {
  const hhmm = (offsetMinutes) => {
    const t = new Date(Date.now() + offsetMinutes * 60_000);
    return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  };
  return { enabled: true, start: hhmm(-2), end: hhmm(2), allowKinds: [] };
}

// ================================================================ N-14 AdjudicateDeps 注入面契约

{
  // 录制型 fake deps：current() 计数 + isKindConfirmed/allChannels 捕获快照引用，
  // 断言「单刻快照恰好 1 次」与「快照引用贯穿派生读面（不二次读 current）」。
  const cfg = baseCfg({ kindRoutes: { ready: ["browser"] } });
  let currentCalls = 0;
  let lastSnapshot = null;
  const seenKind = [];
  const seenSnapshots = [];
  const poolSnapshots = [];
  const browser = { id: "browser", channel: fakeChannel("browser", { titleMaxLen: 64, maxBodyLen: 2048 }), dispatch: { pop: true, sound: { mode: "system", tone: undefined } } };
  const adjudicate = createAdjudicator({
    current: () => {
      currentCalls += 1;
      lastSnapshot = cfg;
      return cfg;
    },
    enabled: () => true,
    isKindConfirmed(kind, snapshot) {
      seenKind.push(kind);
      seenSnapshots.push(snapshot);
      return true;
    },
    allChannels(snapshot) {
      poolSnapshots.push(snapshot);
      return [browser];
    },
  });

  const out = adjudicate({ kind: "ready", title: "T", body: "B", ts: 1 });
  assert.equal(currentCalls, 1, "N-14：单次裁决 current() 恰好 1 次（单刻快照）");
  assert.equal(out.decision, "deliver", "N-14：裁定 deliver");
  assert.equal(seenKind[0], "ready", "N-14：isKindConfirmed 收到 kind");
  assert.equal(seenSnapshots[0], cfg, "N-14：isKindConfirmed 收到 (kind, snapshot) 且快照为 single 对象");
  assert.equal(poolSnapshots[0], cfg, "N-14：allChannels 收到同一快照对象（派生闭包不自行读 current）");
  assert.equal(out.notice.targets.length, 1, "N-14：目标随池解析");
  assert.equal(out.notice.targets[0].dispatch.sound.mode, "system", "N-14：播放决议随池条目携带（裁决时快照解析）");
  console.log("N-14a 单刻快照（current 恰好 1 次 + 快照贯穿派生闭包）: OK");

  // 跨次不缓存：第二次裁决重新取快照（再 +1）
  adjudicate({ kind: "ready", title: "T", body: "B", ts: 2 });
  assert.equal(currentCalls, 2, "N-14：跨次不缓存——第二次裁决重新调 current() 恰好 1 次");
  console.log("N-14b 跨次不缓存（第二次重新取快照）: OK");
}

{
  // 抑制分支形状：disabled（enabled=false）→ suppressed disabled；未确认 →
  // kind-pending；免打扰 → quiet；三者均不触达 allChannels。
  let currentCalls = 0;
  let poolCalls = 0;
  const cfg = baseCfg({ quietHours: quietWindowNow() });
  const baseDeps = {
    current: () => {
      currentCalls += 1;
      return cfg;
    },
    allChannels() {
      poolCalls += 1;
      return [];
    },
  };
  const svcDisabled = createAdjudicator({
    ...baseDeps,
    enabled: () => false,
    isKindConfirmed: () => true,
  });
  const r1 = svcDisabled({ kind: "k", title: "T", body: "B", ts: 1 });
  assert.deepEqual(r1, { decision: "suppressed", reason: "disabled", kind: "k", title: "T", body: "B", ts: 1 }, "N-14：enabled=false → suppressed disabled（形状契约）");
  assert.equal(poolCalls, 0, "N-14：suppressed 不解析投递池");

  const svcPending = createAdjudicator({
    ...baseDeps,
    enabled: () => true,
    isKindConfirmed: () => false,
  });
  const r2 = svcPending({ kind: "k", title: "T", body: "B", ts: 2 });
  assert.equal(r2.decision, "suppressed", "N-14：未确认 → suppressed");
  assert.equal(r2.reason, "kind-pending", "N-14：未确认 → reason = kind-pending");
  assert.equal(poolCalls, 0, "N-14：kind-pending 不解析投递池");

  const svcQuiet = createAdjudicator({
    ...baseDeps,
    enabled: () => true,
    isKindConfirmed: () => true,
  });
  const r3 = svcQuiet({ kind: "k", title: "T", body: "B", ts: 3 });
  assert.equal(r3.reason, "quiet", "N-14：免打扰窗口内 → suppressed quiet");
  assert.equal(poolCalls, 0, "N-14：quiet 不解析投递池");

  // bypassQuiet 放行 + onlyChannel 命中
  const svcBypass = createAdjudicator({
    ...baseDeps,
    enabled: () => true,
    isKindConfirmed: () => true,
    allChannels: (snapshot) => [{ id: "bark:phone", channel: fakeChannel("bark:phone") }],
  });
  const r4 = svcBypass({ kind: "k", title: "T", body: "B", ts: 4, bypassQuiet: true, onlyChannel: "bark:phone" });
  assert.equal(r4.decision, "deliver", "N-14：bypassQuiet 跳过免打扰");
  assert.equal(r4.notice.targets[0].id, "bark:phone", "N-14：onlyChannel 命中单频道");
  assert.equal(poolCalls, 0, "N-14：onlyChannel 用例的池经注入闭包解析（快照单一）");
  console.log("N-14c suppressed 三态形状 + bypassQuiet/onlyChannel: OK");
}

// ================================================================ N-15 DeliverDeps 注入面契约

{
  // 调用序列契约：stale skipped 先 → 带 dispatch 目标经 play、其余经 channel.send →
  // appendHistory 恰好 1 次；play/终态上报载荷为截断后副本（不持原对象引用）。
  const recordStatusCalls = [];
  const emitSentCalls = [];
  const historyCalls = [];
  const playCalls = [];
  const bark = fakeChannel("bark:phone", { titleMaxLen: 10, maxBodyLen: 20 });
  const browser = fakeChannel("browser", { titleMaxLen: 64, maxBodyLen: 2048 });
  const browserTarget = {
    id: "browser",
    channel: browser,
    dispatch: { pop: true, sound: { mode: "system", tone: undefined } },
  };
  const barkTarget = { id: "bark:phone", channel: bark };
  const deliver = createDeliverer({
    recordStatus: (channelId, status, error) => recordStatusCalls.push({ channelId, status, error }),
    emitSent: (payload) => emitSentCalls.push(payload),
    appendHistory: (entry) => historyCalls.push(entry),
    play: (target, payload) => {
      playCalls.push({ target, payload });
      return undefined; // browser 广播同步完成
    },
  });

  const longTitle = "超长标题".repeat(20); // 40 字（>10）
  const longBody = "超长正文".repeat(20); // 60 字（>20）
  const notice = {
    kind: "demo",
    title: longTitle,
    body: longBody,
    severity: "info",
    ts: 42,
    targets: [browserTarget, barkTarget],
    stale: ["bark:gone"],
  };
  const results = deliver(notice);

  assert.deepEqual(results[0], { channelId: "bark:gone", status: "skipped", error: "stale-route" }, "N-15：stale 条目 skipped 在先（结构与现状一致）");
  assert.ok(results.some((r) => r.channelId === "browser" && r.status === "ok"), "N-15：browser 受理 ok");
  assert.ok(results.some((r) => r.channelId === "bark:phone" && r.status === "ok"), "N-15：bark 受理 ok");

  assert.equal(playCalls.length, 1, "N-15：play 仅对带 dispatch 的目标调用");
  assert.equal(playCalls[0].target, browserTarget, "N-15：play 收到目标（含裁决时快照解析的 dispatch）");
  assert.equal(playCalls[0].payload.title, "超长标题".repeat(16), "N-15：play 载荷标题按 browser 能力截断（64 码点）");
  assert.equal(playCalls[0].payload.body, "超长正文".repeat(20), "N-15：play 载荷正文 80 码点 < 2048 未截断");
  assert.equal(playCalls[0].payload.kind, "demo");
  assert.equal(playCalls[0].payload.ts, 42);
  assert.equal(playCalls[0].payload.severity, "info");

  assert.equal(bark.sent.length, 1, "N-15：无 dispatch 目标走 channel.send");
  assert.equal(bark.sent[0].title, "超长标题超长标题超长", "N-15：channel.send 载荷标题按频道能力截断（10 码点）");
  assert.equal(bark.sent[0].body, "超长正文".repeat(5), "N-15：channel.send 载荷正文截断（20 码点）");

  // 终态：同步完成 → recordStatus ok + sent ok（两频道各一条）
  assert.equal(recordStatusCalls.filter((s) => s.status === "ok").length, 2, "N-15：同步终态 ok 落 status");
  assert.equal(emitSentCalls.filter((e) => e.status === "ok").length, 2, "N-15：同步终态 ok 发 sent 事件");
  assert.equal(historyCalls.length, 1, "N-15：appendHistory 每次投递恰好 1 次（通知级，非频道级）");
  assert.deepEqual(historyCalls[0], { ts: 42, kind: "demo", title: longTitle, message: longBody }, "N-15：历史记录字段 = 通知级原始（未按频道截断，与现状 jsonl 契约一致）");
  console.log("N-15a 调用序列（play/channel.send/终态/落史）: OK");
}

{
  // fail-soft + 异步终态 + 终态不持快照引用：
  // play 返回挂起 promise → 终态待决议；reject → recordStatus failed（不牵连其他频道/不抛）；
  // 投递后改写 notice 不影响已记录的终态载荷（值传递语义）。
  const recordStatusCalls = [];
  const emitSentCalls = [];
  const historyCalls = [];
  const deferred = [];
  const okChannel = fakeChannel("bark:ok");
  const failTarget = {
    id: "browser",
    channel: fakeChannel("browser", { titleMaxLen: 64, maxBodyLen: 2048 }),
    dispatch: { pop: false, sound: { mode: "selfplay", tone: undefined } },
  };
  const deliver = createDeliverer({
    recordStatus: (channelId, status, error) => recordStatusCalls.push({ channelId, status, error }),
    emitSent: (payload) => emitSentCalls.push(payload),
    appendHistory: (entry) => historyCalls.push(entry),
    play: () => new Promise((resolve, reject) => deferred.push({ resolve, reject })),
  });
  const notice = {
    kind: "demo",
    title: "T",
    body: "B",
    ts: 7,
    targets: [failTarget, { id: "bark:ok", channel: okChannel }],
    stale: [],
  };
  deliver(notice);
  // 异步目标未决议 → 其终态未上报；同步目标已 ok
  assert.ok(recordStatusCalls.some((s) => s.channelId === "bark:ok" && s.status === "ok"), "N-15：同步目标终态立即可见");
  assert.ok(!recordStatusCalls.some((s) => s.channelId === "browser"), "N-15：异步目标终态待 promise 决议");

  deferred[0].reject(new Error("system notification failed (self-play or command error)"));
  await pollUntil(() => recordStatusCalls.some((s) => s.channelId === "browser"));
  const st = recordStatusCalls.find((s) => s.channelId === "browser");
  assert.equal(st.status, "failed", "N-15：异步 reject → 终态 failed");
  const ev = emitSentCalls.find((e) => e.channelId === "browser");
  assert.equal(ev.status, "failed", "N-15：sent 事件带 failed 终态");

  // 终态不持快照引用：改写 notice 后终态载荷仍是投递时刻截断值
  notice.title = "改写";
  notice.body = "改写";
  assert.equal(emitSentCalls.find((e) => e.channelId === "bark:ok").message, "B", "N-15：终态载荷为值拷贝（改 notice 不影响既有终态）");
  assert.equal(historyCalls[0].message, "B", "N-15：历史为值拷贝");
  console.log("N-15b fail-soft + 异步终态 + 值传递: OK");
}

console.log("dsh-notifier pipeline 注入面契约（N-14/N-15）: OK");