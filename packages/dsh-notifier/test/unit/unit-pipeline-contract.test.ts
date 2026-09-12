/**
 * dsh-notifier — L2 interface 契约：pipeline 域注入面。
 *
 * 层间稳定性：域间经 pipeline/interface.ts 的交互契约——AdjudicateDeps
 * （current() 单刻快照恰好 1 次 / isKindConfirmed 收 (kind, snapshot) / 派生
 * 闭包不读 current）与 DeliverDeps（调用序列与参数 / fail-soft / 终态不持
 * 快照引用）。只 import 本域 interface.ts + deps fake。
 *
 * 本文件为标准红测判别：createAdjudicator/createDeliverer 工厂落地前 import
 * 即红（改前红），工厂落地 + 单刻快照后全绿（改后绿）。另追加框架重试/并发门上移
 * 与 bark 单次投递 + retryable 标注的直测。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createAdjudicator, createDeliverer } from "../../src/pipeline/interface.ts";
import { createBarkChannel } from "../../src/channels/interface.ts";
import type { NotifyConfig } from "../../src/config/interface.ts";
import type {
  AdjudicateDeps,
  AdjudicateResult,
  AdjudicatedNotice,
  BrowserDispatchSpec,
  ChannelPoolEntry,
  DeliverDeps,
  DeliverPayload,
  ResolvedTarget,
} from "../../src/pipeline/interface.ts";
import type { ChannelCapabilities, NotifyChannel, NotifySentEvent, NotifySeverity, RetryableError } from "../../src/sdk/interface.ts";

/** 裁决结果判别分支读面（断言前置的运行时形状由断言自身锁定）。 */
type SuppressedResult = Extract<AdjudicateResult, { decision: "suppressed" }>;
type DeliveredResult = Extract<AdjudicateResult, { decision: "deliver" }>;

/** DeliverDeps.recordStatus 的调用记录。 */
interface StatusCall {
  channelId: string;
  status: "ok" | "failed";
  error: string | undefined;
}

/** DeliverDeps.appendHistory 的入参读面。 */
type HistoryCall = Parameters<DeliverDeps["appendHistory"]>[0];

/** DeliverDeps.play 的调用记录。 */
interface PlayCall {
  target: ResolvedTarget;
  payload: DeliverPayload;
}

/** 轮询直到谓词成立（替代固定 sleep：异步终态经 promise 微任务决议）。 */
async function pollUntil(predicate: () => boolean, timeoutMs = 2000) {
  const start = Date.now();
  for (;;) {
    if (predicate()) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 收口 channel.send 的同步抛与异步 reject，返回投递错误（未失败即抛——断言前置的失败面）。 */
async function sendFailure(outcome: void | Promise<void>): Promise<RetryableError> {
  try {
    await outcome;
  } catch (error) {
    return error as RetryableError;
  }
  throw new Error("预期投递失败，但 channel.send 成功");
}

/**
 * 裁决/投递读面的配置镜像。sanitizeContent 刻意不显式配置：运行时语义 =
 * 缺键（undefined !== false → 容错为 true），故按读面断言为完整配置。
 */
function baseCfg(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
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
  } as unknown as NotifyConfig;
}

/** fake 频道（出站形态：send 记录调用）。 */
function fakeChannel(id: string, caps: ChannelCapabilities = { titleMaxLen: 64, maxBodyLen: 256 }) {
  const sent: DeliverPayload[] = [];
  return {
    name: id,
    capabilities: caps,
    sent,
    send(payload: DeliverPayload) {
      sent.push(payload);
      return undefined;
    },
  };
}

function quietWindowNow() {
  const hhmm = (offsetMinutes: number) => {
    const t = new Date(Date.now() + offsetMinutes * 60_000);
    return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
  };
  return { enabled: true, start: hhmm(-2), end: hhmm(2), allowKinds: [] };
}

// ================================================================ AdjudicateDeps 注入面契约

/** 录制型 fake：断言「单刻快照恰好 1 次」+「快照引用贯穿派生读面」。 */
function recordingAdjudicator() {
  const cfg = baseCfg({ kindRoutes: { ready: ["browser"] } });
  const state = { currentCalls: 0 };
  const seenKind: string[] = [];
  const seenSnapshots: NotifyConfig[] = [];
  const poolSnapshots: NotifyConfig[] = [];
  const browser: ChannelPoolEntry = { id: "browser", channel: fakeChannel("browser", { titleMaxLen: 64, maxBodyLen: 2048 }), dispatch: { pop: true, sound: { mode: "system", tone: undefined } } };
  const adjudicate = createAdjudicator({
    current: () => {
      state.currentCalls += 1;
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
  const raw = adjudicate({ kind: "ready", title: "T", body: "B", ts: 1 });
  // 失败即抛：deliver 分支收窄（原脚本靠 node assert.equal 的 asserts 签名收窄）
  if (raw.decision !== "deliver") throw new Error("预期 deliver 裁决结果");
  const out: DeliveredResult = raw;
  return { cfg, state, seenKind, seenSnapshots, poolSnapshots, adjudicate, out };
}

describe("AdjudicateDeps 注入面契约：单刻快照", () => {
  let f: ReturnType<typeof recordingAdjudicator>;

  beforeEach(() => {
    f = recordingAdjudicator();
  });

  it("N-14：单次裁决 current() 恰好 1 次（单刻快照）", () => {
    expect(f.state.currentCalls).toBe(1);
  });

  it("N-14：裁定 deliver", () => {
    expect(f.out.decision).toBe("deliver");
  });

  it("N-14：isKindConfirmed 收到 kind", () => {
    expect(f.seenKind[0]).toBe("ready");
  });

  it("N-14：isKindConfirmed 收到 (kind, snapshot) 且快照为 single 对象", () => {
    expect(f.seenSnapshots[0]).toBe(f.cfg);
  });

  it("N-14：allChannels 收到同一快照对象（派生闭包不自行读 current）", () => {
    expect(f.poolSnapshots[0]).toBe(f.cfg);
  });

  it("N-14：目标随池解析", () => {
    expect(f.out.notice.targets.length).toBe(1);
  });

  it("N-14：播放决议随池条目携带（裁决时快照解析）", () => {
    expect((f.out.notice.targets[0].dispatch as BrowserDispatchSpec).sound.mode).toBe("system");
  });

  it("N-14：裁决结果携带脱敏开关（快照缺键 → undefined 容错为 true，B-4）", () => {
    expect(f.out.notice.sanitizeContent).toBe(true);
  });

  it("N-14：跨次不缓存——第二次裁决重新调 current() 恰好 1 次", () => {
    // 跨次不缓存：第二次裁决重新取快照（再 +1）
    f.adjudicate({ kind: "ready", title: "T", body: "B", ts: 2 });
    expect(f.state.currentCalls).toBe(2);
  });
});

/** 抑制分支共享 deps（current/allChannels 计数）。 */
function suppressDeps() {
  const state = { currentCalls: 0, poolCalls: 0 };
  const cfg = baseCfg({ quietHours: quietWindowNow() });
  const baseDeps: Pick<AdjudicateDeps, "current" | "allChannels"> = {
    current: () => {
      state.currentCalls += 1;
      return cfg;
    },
    allChannels() {
      state.poolCalls += 1;
      return [];
    },
  };
  return { state, cfg, baseDeps };
}

describe("抑制分支：enabled=false → suppressed disabled", () => {
  let r1: AdjudicateResult;
  let state: ReturnType<typeof suppressDeps>["state"];

  beforeEach(() => {
    const d = suppressDeps();
    state = d.state;
    const svcDisabled = createAdjudicator({
      ...d.baseDeps,
      enabled: () => false,
      isKindConfirmed: () => true,
    });
    r1 = svcDisabled({ kind: "k", title: "T", body: "B", ts: 1 });
  });

  it("N-14：enabled=false → suppressed disabled（形状契约含脱敏开关，快照缺键→true）", () => {
    expect(r1).toEqual({ decision: "suppressed", reason: "disabled", kind: "k", title: "T", body: "B", ts: 1, sanitizeContent: true });
  });

  it("N-14：suppressed 不解析投递池", () => {
    expect(state.poolCalls).toBe(0);
  });
});

describe("抑制分支：未确认 → suppressed kind-pending", () => {
  let r2: SuppressedResult;
  let state: ReturnType<typeof suppressDeps>["state"];

  beforeEach(() => {
    const d = suppressDeps();
    state = d.state;
    const svcPending = createAdjudicator({
      ...d.baseDeps,
      enabled: () => true,
      isKindConfirmed: () => false,
    });
    r2 = svcPending({ kind: "k", title: "T", body: "B", ts: 2 }) as SuppressedResult;
  });

  it("N-14：未确认 → suppressed", () => {
    expect(r2.decision).toBe("suppressed");
  });

  it("N-14：未确认 → reason = kind-pending", () => {
    expect(r2.reason).toBe("kind-pending");
  });

  it("N-14：kind-pending 不解析投递池", () => {
    expect(state.poolCalls).toBe(0);
  });
});

describe("抑制分支：免打扰窗口内 → suppressed quiet", () => {
  let r3: SuppressedResult;
  let state: ReturnType<typeof suppressDeps>["state"];

  beforeEach(() => {
    const d = suppressDeps();
    state = d.state;
    const svcQuiet = createAdjudicator({
      ...d.baseDeps,
      enabled: () => true,
      isKindConfirmed: () => true,
    });
    r3 = svcQuiet({ kind: "k", title: "T", body: "B", ts: 3 }) as SuppressedResult;
  });

  it("N-14：免打扰窗口内 → suppressed quiet", () => {
    expect(r3.reason).toBe("quiet");
  });

  it("N-14：quiet 不解析投递池", () => {
    expect(state.poolCalls).toBe(0);
  });
});

describe("bypassQuiet 放行 + onlyChannel 命中单频道", () => {
  let r4: DeliveredResult;
  let state: ReturnType<typeof suppressDeps>["state"];

  beforeEach(() => {
    const d = suppressDeps();
    state = d.state;
    const svcBypass = createAdjudicator({
      ...d.baseDeps,
      enabled: () => true,
      isKindConfirmed: () => true,
      allChannels: () => [{ id: "bark:phone", channel: fakeChannel("bark:phone") }],
    });
    r4 = svcBypass({ kind: "k", title: "T", body: "B", ts: 4, bypassQuiet: true, onlyChannel: "bark:phone" }) as DeliveredResult;
  });

  it("N-14：bypassQuiet 跳过免打扰", () => {
    expect(r4.decision).toBe("deliver");
  });

  it("N-14：onlyChannel 命中单频道", () => {
    expect(r4.notice.targets[0].id).toBe("bark:phone");
  });

  it("N-14：onlyChannel 用例的池经注入闭包解析（快照单一）", () => {
    expect(state.poolCalls).toBe(0);
  });
});

describe("快照显式 sanitizeContent=false → 结果携带 false", () => {
  it("N-14：sanitizeContent=false 随裁决结果携带（B-4）", () => {
    // 编排层据此明文落史/投递
    const d = suppressDeps();
    const svcPlain = createAdjudicator({
      ...d.baseDeps,
      enabled: () => true,
      isKindConfirmed: () => true,
      current: () => ({ ...d.cfg, sanitizeContent: false }),
    });
    const r5 = svcPlain({ kind: "k", title: "T", body: "B", ts: 5, bypassQuiet: true }) as DeliveredResult;
    expect(r5.notice.sanitizeContent).toBe(false);
  });
});

// ================================================================ DeliverDeps 注入面契约

/** 调用序列：stale skipped 先 → play/channel.send 分流 → appendHistory 恰好 1 次。 */
function deliverSequence() {
  const recordStatusCalls: StatusCall[] = [];
  const emitSentCalls: NotifySentEvent[] = [];
  const historyCalls: HistoryCall[] = [];
  const playCalls: PlayCall[] = [];
  const bark = fakeChannel("bark:phone", { titleMaxLen: 10, maxBodyLen: 20 });
  const browser = fakeChannel("browser", { titleMaxLen: 64, maxBodyLen: 2048 });
  const browserTarget: ResolvedTarget = {
    id: "browser",
    channel: browser,
    dispatch: { pop: true, sound: { mode: "system", tone: undefined } },
  };
  const barkTarget: ResolvedTarget = { id: "bark:phone", channel: bark };
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
  const notice: AdjudicatedNotice = {
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
  return { recordStatusCalls, emitSentCalls, historyCalls, playCalls, bark, browserTarget, notice, results, longTitle, longBody };
}

describe("DeliverDeps 注入面契约：调用序列与载荷截断", () => {
  let s: ReturnType<typeof deliverSequence>;

  beforeEach(() => {
    s = deliverSequence();
  });

  it("N-15：stale 条目 skipped 在先（结构与现状一致）", () => {
    expect(s.results[0]).toEqual({ channelId: "bark:gone", status: "skipped", error: "stale-route" });
  });

  it("N-15：browser 受理 ok", () => {
    expect(s.results.some((r) => r.channelId === "browser" && r.status === "ok")).toBeTruthy();
  });

  it("N-15：bark 受理 ok", () => {
    expect(s.results.some((r) => r.channelId === "bark:phone" && r.status === "ok")).toBeTruthy();
  });

  it("N-15：play 仅对带 dispatch 的目标调用", () => {
    expect(s.playCalls.length).toBe(1);
  });

  it("N-15：play 收到目标（含裁决时快照解析的 dispatch）", () => {
    expect(s.playCalls[0].target).toBe(s.browserTarget);
  });

  it("N-15：play 载荷标题按 browser 能力截断（64 码点）", () => {
    expect(s.playCalls[0].payload.title).toBe("超长标题".repeat(16));
  });

  it("N-15：play 载荷正文 80 码点 < 2048 未截断", () => {
    expect(s.playCalls[0].payload.body).toBe("超长正文".repeat(20));
  });

  it("N-15：play 载荷 kind 透传", () => {
    expect(s.playCalls[0].payload.kind).toBe("demo");
  });

  it("N-15：play 载荷 ts 透传", () => {
    expect(s.playCalls[0].payload.ts).toBe(42);
  });

  it("N-15：play 载荷 severity 透传", () => {
    expect(s.playCalls[0].payload.severity).toBe("info");
  });

  it("N-15：无 dispatch 目标走 channel.send", () => {
    expect(s.bark.sent.length).toBe(1);
  });

  it("N-15：channel.send 载荷标题按频道能力截断（10 码点）", () => {
    expect(s.bark.sent[0].title).toBe("超长标题超长标题超长");
  });

  it("N-15：channel.send 载荷正文截断（20 码点）", () => {
    expect(s.bark.sent[0].body).toBe("超长正文".repeat(5));
  });

  it("N-15：同步终态 ok 落 status", () => {
    // 终态：同步完成 → recordStatus ok + sent ok（两频道各一条）
    expect(s.recordStatusCalls.filter((x) => x.status === "ok").length).toBe(2);
  });

  it("N-15：同步终态 ok 发 sent 事件", () => {
    expect(s.emitSentCalls.filter((e) => e.status === "ok").length).toBe(2);
  });

  it("N-15：appendHistory 每次投递恰好 1 次（通知级，非频道级）", () => {
    expect(s.historyCalls.length).toBe(1);
  });

  it("N-15：历史记录字段 = 通知级原始（未按频道截断，与现状 jsonl 契约一致）", () => {
    expect(s.historyCalls[0]).toEqual({ ts: 42, kind: "demo", title: s.longTitle, message: s.longBody });
  });
});

/** fail-soft 异步终态夹具（不决议 / 决议由用例自行推进）。 */
function failSoftFixture() {
  const recordStatusCalls: StatusCall[] = [];
  const emitSentCalls: NotifySentEvent[] = [];
  const historyCalls: HistoryCall[] = [];
  const deferred: Array<{ resolve: (value: void) => void; reject: (reason?: unknown) => void }> = [];
  const okChannel = fakeChannel("bark:ok");
  const failTarget: ResolvedTarget = {
    id: "browser",
    channel: fakeChannel("browser", { titleMaxLen: 64, maxBodyLen: 2048 }),
    dispatch: { pop: false, sound: { mode: "selfplay", tone: undefined } },
  };
  const deliver = createDeliverer({
    recordStatus: (channelId, status, error) => recordStatusCalls.push({ channelId, status, error }),
    emitSent: (payload) => emitSentCalls.push(payload),
    appendHistory: (entry) => historyCalls.push(entry),
    play: () => new Promise<void>((resolve, reject) => deferred.push({ resolve, reject })),
  });
  const notice: AdjudicatedNotice = {
    kind: "demo",
    title: "T",
    body: "B",
    ts: 7,
    targets: [failTarget, { id: "bark:ok", channel: okChannel }],
    stale: [],
    sanitizeContent: true,
  };
  deliver(notice);
  return { recordStatusCalls, emitSentCalls, historyCalls, deferred, notice };
}

describe("fail-soft + 异步终态：受理与终态解耦", () => {
  let f: ReturnType<typeof failSoftFixture>;

  beforeEach(() => {
    f = failSoftFixture();
  });

  it("N-15：同步目标终态立即可见", () => {
    // 异步目标未决议 → 其终态未上报；同步目标已 ok
    expect(f.recordStatusCalls.some((s) => s.channelId === "bark:ok" && s.status === "ok")).toBeTruthy();
  });

  it("N-15：异步目标终态待 promise 决议", () => {
    expect(!f.recordStatusCalls.some((s) => s.channelId === "browser")).toBeTruthy();
  });
});

describe("fail-soft + 异步终态：reject → failed 不牵连其他频道", () => {
  let f: ReturnType<typeof failSoftFixture>;

  beforeEach(async () => {
    f = failSoftFixture();
    f.deferred[0].reject(new Error("system notification failed (self-play or command error)"));
    await pollUntil(() => f.recordStatusCalls.some((s) => s.channelId === "browser"));
  });

  it("N-15：异步 reject → 终态 failed", () => {
    const st = f.recordStatusCalls.find((s) => s.channelId === "browser") as StatusCall;
    expect(st.status).toBe("failed");
  });

  it("N-15：sent 事件带 failed 终态", () => {
    const ev = f.emitSentCalls.find((e) => e.channelId === "browser") as NotifySentEvent;
    expect(ev.status).toBe("failed");
  });

  it("N-15：终态载荷为值拷贝（改 notice 不影响既有终态）", () => {
    // 终态不持快照引用：改写 notice 后终态载荷仍是投递时刻截断值
    f.notice.title = "改写";
    f.notice.body = "改写";
    expect((f.emitSentCalls.find((e) => e.channelId === "bark:ok") as NotifySentEvent).message).toBe("B");
  });

  it("N-15：历史为值拷贝", () => {
    f.notice.title = "改写";
    f.notice.body = "改写";
    expect(f.historyCalls[0].message).toBe("B");
  });
});

describe("mergeTitleIntoBody 直测：显式声明 → 标题拼入正文", () => {
  // 红测判别：拆分前结构无此字段与拼入逻辑——fake 频道声明 true 时框架仍走独立
  // 标题分支（字段 undefined 不回退拼入），title 空串断言改前红；实现后绿。
  let merged: ReturnType<typeof fakeChannel>;
  let capped: ReturnType<typeof fakeChannel>;
  let separate: ReturnType<typeof fakeChannel>;
  let deliver: ReturnType<typeof createDeliverer>;

  const noticeFor = (title: string, body: string, ts: number): AdjudicatedNotice => ({
    kind: "demo", title, body, ts,
    targets: [
      { id: "merged", channel: merged },
      { id: "capped", channel: capped },
      { id: "separate", channel: separate },
    ],
    stale: [],
    sanitizeContent: true,
  });

  beforeEach(() => {
    merged = fakeChannel("merged", { titleMaxLen: 6, maxBodyLen: 12, mergeTitleIntoBody: true });
    capped = fakeChannel("capped", { titleMaxLen: 64, maxBodyLen: 4, mergeTitleIntoBody: true });
    separate = fakeChannel("separate", { titleMaxLen: 4, maxBodyLen: 64, mergeTitleIntoBody: false });
    deliver = createDeliverer({
      recordStatus: () => undefined,
      emitSent: () => undefined,
      appendHistory: () => undefined,
      play: () => undefined,
    });
    deliver(noticeFor("标题", "正文", 9));
  });

  it("L8-1：mergeTitleIntoBody=true → title 位空串（不传独立标题）", () => {
    expect(merged.sent[0].title).toBe("");
  });

  it("L8-1：标题拼入正文（`${title}\\n${body}` 形态）", () => {
    expect(merged.sent[0].body).toBe("标题\n正文");
  });

  it("L8-1：拼入频道 title 位恒空串（长度权威 = body 截断）", () => {
    expect(capped.sent[0].title).toBe("");
  });

  it("L8-1：拼入后仍按 maxBodyLen 截断（4 码点），不再按 titleMaxLen 单独截断", () => {
    expect(capped.sent[0].body).toBe("标题\n正");
  });

  it("L8-1：空 title 位仍空串", () => {
    // 空 title：不产生多余换行（纯 body）
    deliver(noticeFor("", "纯正文", 10));
    expect(merged.sent[1].title).toBe("");
  });

  it("L8-1：空 title 拼入后无多余换行", () => {
    deliver(noticeFor("", "纯正文", 10));
    expect(merged.sent[1].body).toBe("纯正文");
  });

  it("L8-1：false → 独立标题现状（不并入正文）", () => {
    // mergeTitleIntoBody=false/undefined → 独立标题现状（显式 false 与缺省同语义）
    expect(separate.sent[0].title).toBe("标题");
  });

  it("L8-1：false → 正文不拼入标题", () => {
    expect(separate.sent[0].body).toBe("正文");
  });
});

// ================================================================ 框架重试/并发门（上移直测）
// 重试与门由 createDeliverer 承载（对等现状 bark sendWithRetry/sendWithGate），
// 判据 = channel.capabilities.retry/maxInflight + RetryableError（false 不重试）。

function deliverDeps(recordStatusCalls: StatusCall[] = []): DeliverDeps {
  return {
    recordStatus: (channelId, status, error) => recordStatusCalls.push({ channelId, status, error }),
    emitSent: () => undefined,
    appendHistory: () => undefined,
    play: () => undefined,
  };
}

function retryableErr(message: string, retryable: boolean): RetryableError {
  const e = new Error(message) as RetryableError;
  e.retryable = retryable;
  return e;
}

function mkNotice(ts: number, channel: NotifyChannel): AdjudicatedNotice {
  return { kind: "demo", title: "T", body: "B", ts, targets: [{ id: "bark:phone", channel }], stale: [], sanitizeContent: true };
}

/** 4xx（retryable:false）不重试夹具：1 次调用 + 终态 failed。 */
function noRetryFixture() {
  const state = { attempts: 0 };
  const channel = {
    name: "bark:phone",
    capabilities: { titleMaxLen: 64, maxBodyLen: 256, retry: { maxRetries: 2, backoffMs: 0 } },
    send() {
      state.attempts += 1;
      return Promise.reject(retryableErr("bark HTTP 400: bad request", false));
    },
  };
  const recordStatusCalls: StatusCall[] = [];
  const deliver = createDeliverer(deliverDeps(recordStatusCalls));
  const results = deliver(mkNotice(1, channel));
  return { state, recordStatusCalls, results };
}

describe("框架重试：4xx（retryable:false）不重试", () => {
  it("N-9a：受理与终态解耦（铁律 1）", () => {
    expect(noRetryFixture().results[0].status).toBe("ok");
  });

  it("N-9a：retryable:false 不重试", async () => {
    const f = noRetryFixture();
    await pollUntil(() => f.recordStatusCalls.some((s) => s.channelId === "bark:phone"));
    expect(f.state.attempts).toBe(1);
  });

  it("N-9a：4xx → 终态 failed", async () => {
    const f = noRetryFixture();
    await pollUntil(() => f.recordStatusCalls.some((s) => s.channelId === "bark:phone"));
    expect(f.recordStatusCalls[0].status).toBe("failed");
  });
});

/**
 * 5xx（retryable:true）重试 ×2 后成功 + 线性退避 1s/2s 夹具：
 * 替换 setTimeout 记录延时并立即执行（零真实等待），返回前恢复原 setTimeout。
 */
async function retryFixture(): Promise<{ attempts: number; delays: number[]; recordStatusCalls: StatusCall[] }> {
  const delays: number[] = [];
  const origTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    delays.push(ms);
    fn();
    return 0;
  }) as unknown as typeof setTimeout;
  const state = { attempts: 0 };
  const channel = {
    name: "bark:phone",
    capabilities: { titleMaxLen: 64, maxBodyLen: 256, retry: { maxRetries: 2, backoffMs: 1000 } },
    send() {
      state.attempts += 1;
      if (state.attempts < 3) return Promise.reject(retryableErr(`bark 5xx (${state.attempts})`, true));
      return Promise.resolve();
    },
  };
  const recordStatusCalls: StatusCall[] = [];
  const deliver = createDeliverer(deliverDeps(recordStatusCalls));
  try {
    deliver(mkNotice(1, channel));
    for (let i = 0; i < 30; i += 1) await Promise.resolve(); // 推满替换窗口内微任务链
  } finally {
    globalThis.setTimeout = origTimeout;
  }
  return { attempts: state.attempts, delays, recordStatusCalls };
}

describe("框架重试：5xx（retryable:true）重试 ×2 后成功 + 线性退避", () => {
  it("N-9b：重试 ×2（1 + 2）", async () => {
    expect((await retryFixture()).attempts).toBe(3);
  });

  it("N-9b：线性退避 1s/2s（backoffMs 基数）", async () => {
    expect((await retryFixture()).delays).toEqual([1000, 2000]);
  });

  it("N-9b：重试后成功 → 终态 ok", async () => {
    const f = await retryFixture();
    await pollUntil(() => f.recordStatusCalls.some((s) => s.channelId === "bark:phone"));
    expect(f.recordStatusCalls[0].status).toBe("ok");
  });
});

describe("框架并发门：maxInflight 超限排队 + 门跨配置变更延续", () => {
  // 在途≥2 时第 3 个排队（含「同 channelId 换新 channel 实例」仍排队：门表按
  // channelId 键控于 createDeliverer 闭包，对等现状 outbound.ts:13-22 的 barkGates Map 语义）
  let calls: number;
  let pendings: Array<() => void>;
  let deliver: ReturnType<typeof createDeliverer>;

  beforeEach(() => {
    pendings = [];
    calls = 0;
    const makeChannel = () => ({
      name: "bark:phone",
      capabilities: { titleMaxLen: 64, maxBodyLen: 256, maxInflight: 2 },
      send() {
        calls += 1;
        return new Promise<void>((resolve) => pendings.push(resolve));
      },
    });
    deliver = createDeliverer(deliverDeps());
    const channelA = makeChannel();
    deliver(mkNotice(1, channelA));
    deliver(mkNotice(2, channelA));
    deliver(mkNotice(3, makeChannel())); // 同 id 新实例（模拟配置变更后频道重建）
  });

  it("N-9c/d：在途 2 时第 3 个排队（跨实例延续）", async () => {
    expect(calls).toBe(2);
    // 原块尾部排水（非断言）：放行在途项后排队项推进，避免悬挂 promise
    pendings[0]();
    await pollUntil(() => calls === 3);
  });
});

// ================================================================ bark 单次投递 + retryable 标注
const barkChannel = () => createBarkChannel({ id: "p", type: "bark", baseUrl: "https://h", deviceKey: "SECRETKEY22", enabled: true });

describe("bark 能力契约", () => {
  it("N-13：bark retry 契约（框架据此重试 ×2、退避 1s 基数）", () => {
    expect(barkChannel().capabilities.retry).toEqual({ maxRetries: 2, backoffMs: 1000 });
  });

  it("N-13：bark maxInflight=2（框架门上移用）", () => {
    expect(barkChannel().capabilities.maxInflight).toBe(2);
  });
});

/** 注入 fetch 桩发一次 bark send 并收口失败面（返回调用次数与投递错误）。 */
async function barkFailure(response: () => unknown): Promise<{ fetchCalls: number; err: RetryableError }> {
  const origFetch = globalThis.fetch;
  const state = { fetchCalls: 0 };
  try {
    globalThis.fetch = (async () => {
      state.fetchCalls += 1;
      return response();
    }) as unknown as typeof fetch;
    const err = await sendFailure(barkChannel().send({ title: "T", body: "B", kind: "test", ts: 1 }));
    return { fetchCalls: state.fetchCalls, err };
  } finally {
    globalThis.fetch = origFetch;
  }
}

describe("bark 单次投递 + retryable 标注", () => {
  const cases: Array<{ label: string; response: () => unknown; want: boolean }> = [
    { label: "4xx 确定失败", response: () => ({ ok: false, status: 400, text: async () => "bad" }), want: false },
    { label: "网络错误", response: () => { throw new TypeError("fetch failed"); }, want: true },
    { label: "5xx", response: () => ({ ok: false, status: 503, text: async () => "unavailable" }), want: true },
  ];

  for (const c of cases) {
    it(`N-13：channel 单次投递（重试是框架职责）——${c.label}`, async () => {
      expect((await barkFailure(c.response)).fetchCalls).toBe(1);
    });

    it(`N-13：retryable=${c.want}——${c.label}`, async () => {
      expect((await barkFailure(c.response)).err.retryable).toBe(c.want);
    });
  }
});

// ================================================================ #733 M2-3.4 severity 入口校验

/**
 * 跨边界非法输入构造：宿主 / 未类型化调用方 / PUT 配置传来的值不受编译期联合约束，
 * 「运行时不合法」这一事实无法用静态类型表达，故经 unknown 形参中转（测试判据是
 * 运行时守卫，不是编译期约束）。不用 `as unknown as`。
 */
function wire<T>(value: unknown): T {
  return value as T;
}

describe("裁决入口 severity 运行时校验（#733 M2-3.4）", () => {
  /** 走一遍真实裁决，取 deliver 分支的 notice.severity（非 deliver 即抛）。 */
  function severityOfDelivered(rawSeverity: unknown): unknown {
    const browser: ChannelPoolEntry = { id: "browser", channel: fakeChannel("browser"), dispatch: { pop: true, sound: { mode: "system", tone: undefined } } };
    const adjudicate = createAdjudicator({
      current: () => baseCfg(),
      enabled: () => true,
      isKindConfirmed: () => true,
      allChannels: () => [browser],
    });
    const result = adjudicate({ kind: "ready", title: "T", body: "B", severity: wire<NotifySeverity>(rawSeverity), ts: 1 });
    if (result.decision !== "deliver") throw new Error("预期 deliver 裁决结果");
    return result.notice.severity;
  }

  it("合法 severity 原样进入 notice（行为零回归）", () => {
    for (const severity of ["info", "success", "warning", "failure"] as NotifySeverity[]) {
      expect(severityOfDelivered(severity)).toBe(severity);
    }
  });

  it("非法 severity 回落 undefined（= 视同未提供），不把原文带进投递载荷", () => {
    const invalidValues: unknown[] = ["critical", "<script>alert(1)</script>", "", "INFO", 0, 1, true, null, {}, []];
    // 先断言样本非空：空数组下循环体不执行，判据退化为恒真。
    expect(invalidValues.length).toBe(10);
    for (const bad of invalidValues) expect(severityOfDelivered(bad)).toBeUndefined();
  });

  it("未提供 severity → undefined（非法值的回落与既有缺省走同一条路径）", () => {
    expect(severityOfDelivered(undefined)).toBeUndefined();
  });
});
