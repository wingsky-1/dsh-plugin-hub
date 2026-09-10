// @ts-nocheck
/**
 * dsh-notifier — L2 interface 契约：pipeline 域注入面（N-14/N-15，PR2 T2-1）。
 *
 * 层间稳定性：域间经 pipeline/interface.ts 的交互契约——AdjudicateDeps
 * （current() 单刻快照恰好 1 次 / isKindConfirmed 收 (kind, snapshot) / 派生
 * 闭包不读 current）与 DeliverDeps（调用序列与参数 / fail-soft / 终态不持
 * 快照引用）。按 §11.2-1/2：只 import 本域 interface.ts + deps fake。
 *
 * 本文件为标准红测判别：createAdjudicator/createDeliverer 工厂落地前 import
 * 即红（改前红），工厂落地 + 单刻快照后全绿（改后绿）。T2-2 起追加 N-9
 * （框架重试/并发门上移，B-3）与 N-13（bark 单次投递 + retryable 标注）直测。
 */
import assert from "node:assert/strict";
import { createAdjudicator, createDeliverer } from "../src/pipeline/interface.ts";
import { createBarkChannel } from "../src/channels/interface.ts";

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
  // 录制型 fake：断言「单刻快照恰好 1 次」+「快照引用贯穿派生读面」
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
  assert.equal(out.notice.sanitizeContent, true, "N-14：裁决结果携带脱敏开关（快照缺键 → undefined 容错为 true，B-4）");
  // 跨次不缓存：第二次裁决重新取快照（再 +1）
  adjudicate({ kind: "ready", title: "T", body: "B", ts: 2 });
  assert.equal(currentCalls, 2, "N-14：跨次不缓存——第二次裁决重新调 current() 恰好 1 次");
}

{
  // 抑制分支形状：disabled/未确认/免打扰 三态均不触达 allChannels
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
  assert.deepEqual(r1, { decision: "suppressed", reason: "disabled", kind: "k", title: "T", body: "B", ts: 1, sanitizeContent: true }, "N-14：enabled=false → suppressed disabled（形状契约含脱敏开关，快照缺键→true）");
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

  // B-4：快照显式 sanitizeContent=false → 结果携带 false（编排层据此明文落史/投递）
  const svcPlain = createAdjudicator({
    ...baseDeps,
    enabled: () => true,
    isKindConfirmed: () => true,
    current: () => ({ ...cfg, sanitizeContent: false }),
  });
  const r5 = svcPlain({ kind: "k", title: "T", body: "B", ts: 5, bypassQuiet: true });
  assert.equal(r5.notice.sanitizeContent, false, "N-14：sanitizeContent=false 随裁决结果携带（B-4）");
}

// ================================================================ N-15 DeliverDeps 注入面契约

{
  // 调用序列：stale skipped 先 → play/channel.send 分流 → appendHistory 恰好 1 次
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
    sanitizeContent: true,
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
}

{
  // fail-soft + 异步终态：reject → failed 不牵连其他频道；终态为值拷贝（不持快照引用）
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
    sanitizeContent: true,
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
}

{
  // N-15 追加（L8-1）：mergeTitleIntoBody 显式声明 → 标题拼入正文。
  // 红测判别：T2-1 结构无此字段与拼入逻辑——fake 频道声明 true 时框架仍走独立
  // 标题分支（字段 undefined 不回退拼入），title 空串断言改前红；实现后绿。
  const merged = fakeChannel("merged", { titleMaxLen: 6, maxBodyLen: 12, mergeTitleIntoBody: true });
  const capped = fakeChannel("capped", { titleMaxLen: 64, maxBodyLen: 4, mergeTitleIntoBody: true });
  const separate = fakeChannel("separate", { titleMaxLen: 4, maxBodyLen: 64, mergeTitleIntoBody: false });
  const deliver = createDeliverer({
    recordStatus: () => undefined,
    emitSent: () => undefined,
    appendHistory: () => undefined,
    play: () => undefined,
  });
  const noticeFor = (title, body, ts) => ({
    kind: "demo", title, body, ts,
    targets: [
      { id: "merged", channel: merged },
      { id: "capped", channel: capped },
      { id: "separate", channel: separate },
    ],
    stale: [],
    sanitizeContent: true,
  });

  deliver(noticeFor("标题", "正文", 9));
  assert.equal(merged.sent[0].title, "", "L8-1：mergeTitleIntoBody=true → title 位空串（不传独立标题）");
  assert.equal(merged.sent[0].body, "标题\n正文", "L8-1：标题拼入正文（`${title}\\n${body}` 形态）");
  assert.equal(capped.sent[0].title, "", "L8-1：拼入频道 title 位恒空串（长度权威 = body 截断）");
  assert.equal(capped.sent[0].body, "标题\n正", "L8-1：拼入后仍按 maxBodyLen 截断（4 码点），不再按 titleMaxLen 单独截断");

  // 空 title：不产生多余换行（纯 body）
  deliver(noticeFor("", "纯正文", 10));
  assert.equal(merged.sent[1].title, "", "L8-1：空 title 位仍空串");
  assert.equal(merged.sent[1].body, "纯正文", "L8-1：空 title 拼入后无多余换行");

  // mergeTitleIntoBody=false/undefined → 独立标题现状（显式 false 与缺省同语义）
  assert.equal(separate.sent[0].title, "标题", "L8-1：false → 独立标题现状（不并入正文）");
  assert.equal(separate.sent[0].body, "正文", "L8-1：false → 正文不拼入标题");
}

// ================================================================ N-9 框架重试/并发门（B-3 上移直测）
// 重试与门由 createDeliverer 承载（对等现状 bark sendWithRetry/sendWithGate），
// 判据 = channel.capabilities.retry/maxInflight + RetryableError（false 不重试）。

function deliverDeps(recordStatusCalls = []) {
  return {
    recordStatus: (channelId, status, error) => recordStatusCalls.push({ channelId, status, error }),
    emitSent: () => undefined,
    appendHistory: () => undefined,
    play: () => undefined,
  };
}

function retryableErr(message, retryable) {
  const e = new Error(message);
  e.retryable = retryable;
  return e;
}

function mkNotice(ts, channel) {
  return { kind: "demo", title: "T", body: "B", ts, targets: [{ id: "bark:phone", channel }], stale: [], sanitizeContent: true };
}

{
  // N-9a：4xx（retryable:false）不重试 → 1 次调用 + 终态 failed；受理与终态解耦
  let attempts = 0;
  const channel = {
    name: "bark:phone",
    capabilities: { titleMaxLen: 64, maxBodyLen: 256, retry: { maxRetries: 2, backoffMs: 0 } },
    send() {
      attempts += 1;
      return Promise.reject(retryableErr("bark HTTP 400: bad request", false));
    },
  };
  const recordStatusCalls = [];
  const deliver = createDeliverer(deliverDeps(recordStatusCalls));
  const results = deliver(mkNotice(1, channel));
  assert.equal(results[0].status, "ok", "N-9a：受理与终态解耦（铁律 1）");
  await pollUntil(() => recordStatusCalls.some((s) => s.channelId === "bark:phone"));
  assert.equal(attempts, 1, "N-9a：retryable:false 不重试");
  assert.equal(recordStatusCalls[0].status, "failed", "N-9a：4xx → 终态 failed");
}

{
  // N-9b：5xx（retryable:true）重试 ×2 后成功 + 线性退避 1s/2s（替换 setTimeout
  // 记录延时并立即执行，零真实等待）→ 终态 ok
  const delays = [];
  const origTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => {
    delays.push(ms);
    fn();
    return 0;
  };
  let attempts = 0;
  const channel = {
    name: "bark:phone",
    capabilities: { titleMaxLen: 64, maxBodyLen: 256, retry: { maxRetries: 2, backoffMs: 1000 } },
    send() {
      attempts += 1;
      if (attempts < 3) return Promise.reject(retryableErr(`bark 5xx (${attempts})`, true));
      return Promise.resolve();
    },
  };
  const recordStatusCalls = [];
  const deliver = createDeliverer(deliverDeps(recordStatusCalls));
  try {
    deliver(mkNotice(1, channel));
    for (let i = 0; i < 30; i += 1) await Promise.resolve(); // 推满替换窗口内微任务链
  } finally {
    globalThis.setTimeout = origTimeout;
  }
  assert.equal(attempts, 3, "N-9b：重试 ×2（1 + 2）");
  assert.deepEqual(delays, [1000, 2000], "N-9b：线性退避 1s/2s（backoffMs 基数）");
  await pollUntil(() => recordStatusCalls.some((s) => s.channelId === "bark:phone"));
  assert.equal(recordStatusCalls[0].status, "ok", "N-9b：重试后成功 → 终态 ok");
}

{
  // N-9c/d：maxInflight 超限排队 + 门跨配置变更延续——在途≥2 时第 3 个排队
  // （含「同 channelId 换新 channel 实例」仍排队：门表按 channelId 键控于
  // createDeliverer 闭包，对等现状 outbound.ts:13-22 的 barkGates Map 语义）
  const pendings = [];
  let calls = 0;
  const makeChannel = () => ({
    name: "bark:phone",
    capabilities: { titleMaxLen: 64, maxBodyLen: 256, maxInflight: 2 },
    send() {
      calls += 1;
      return new Promise((resolve) => pendings.push(resolve));
    },
  });
  const deliver = createDeliverer(deliverDeps());
  const channelA = makeChannel();
  deliver(mkNotice(1, channelA));
  deliver(mkNotice(2, channelA));
  deliver(mkNotice(3, makeChannel())); // 同 id 新实例（模拟配置变更后频道重建）
  assert.equal(calls, 2, "N-9c/d：在途 2 时第 3 个排队（跨实例延续）");
  pendings[0]();
  await pollUntil(() => calls === 3);
}

// ================================================================ N-13 bark 单次投递 + retryable 标注（B-3）
{
  const origFetch = globalThis.fetch;
  try {
    const ch = createBarkChannel({ id: "p", type: "bark", baseUrl: "https://h", deviceKey: "SECRETKEY22", enabled: true });
    assert.deepEqual(ch.capabilities.retry, { maxRetries: 2, backoffMs: 1000 }, "N-13：bark retry 契约（框架据此重试 ×2、退避 1s 基数）");
    assert.equal(ch.capabilities.maxInflight, 2, "N-13：bark maxInflight=2（框架门上移用）");
    let fetchCalls = 0;
    const expectRetryable = async (respond, want) => {
      fetchCalls = 0;
      globalThis.fetch = async () => {
        fetchCalls += 1;
        return respond();
      };
      let lastErr = null;
      await ch.send({ title: "T", body: "B", kind: "test", ts: 1 }).catch((e) => { lastErr = e; });
      assert.equal(fetchCalls, 1, "N-13：channel 单次投递（重试是框架职责）");
      assert.equal(lastErr.retryable, want, `N-13：retryable=${want}`);
    };
    await expectRetryable(() => ({ ok: false, status: 400, text: async () => "bad" }), false); // 4xx 确定失败
    await expectRetryable(() => { throw new TypeError("fetch failed"); }, true); // 网络错误
    await expectRetryable(() => ({ ok: false, status: 503, text: async () => "unavailable" }), true); // 5xx
  } finally {
    globalThis.fetch = origFetch;
  }
  console.log("N-13 bark 单次投递 + retryable 标注: OK");
}

console.log("dsh-notifier pipeline 注入面契约（N-14/N-15）: OK");