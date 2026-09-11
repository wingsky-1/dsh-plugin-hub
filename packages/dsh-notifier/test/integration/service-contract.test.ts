/**
 * dsh-notifier — 通知中心 service 契约测试。
 *
 * 直接构造 createNotifierService 的 deps（fake sse/system/history/logger），
 * 聚焦 service 自身契约（不经完整 apply，速度快且隔离）：
 * - 内置事件源 → severity 映射静态表（评审契约）
 * - send() 受理语义：enabled=false / 非法形状 / 内置 kind 走文案管线
 * - 动态 kind 待确认：未确认 → suppressed 落史；confirmKind 后放行
 * - registerKind 防冒认（前缀为内置 kind 名拒绝；无 ':' 拒绝）
 * - fail-soft 逐频道投递：单频道抛错不牵连
 *
 * 迁移说明：原脚本块为「动作 → 断言」序列；断言的观测值（帧/历史/终态/调用
 * 索引）在夹具中被物化，用例只读这些快照——不会观察到后续动作改写过的状态。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createNotifierService, KIND_SEVERITY, BUILTIN_CHANNELS, createBarkChannel, SEVERITY_LEVEL, buildBrowserFrame } from "../../src/index.ts";
import { createBrowserChannel, createSystemChannel } from "../../src/channels/interface.ts";
import type { BarkChannelConfig, NotifyConfig, SoundSetting } from "../../src/config/interface.ts";
import type { BrowserDispatchSpec, DeliverPayload, SystemDispatchSpec } from "../../src/pipeline/interface.ts";
import type { NotifyChannel, NotifyRequest, NotifySentEvent, RetryableError } from "../../src/sdk/interface.ts";
import type { SseHub } from "../../src/server/interface.ts";
import type { HistoryEntry } from "../../src/stores/interface.ts";
import { quietWindowNow } from "../helpers.ts";

// ---------------------------------------------------------------- fake deps

/** 轮询直到谓词成立（替代固定 sleep：异步终态经 promise 微任务/定时器回调，轮询比等固定毫秒稳）。 */
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

/** fake SSE hub（记录 broadcast 帧）。 */
function fakeSse() {
  const frames: Array<Record<string, unknown>> = [];
  return {
    frames,
    broadcast(payload: Record<string, unknown>): void {
      frames.push(payload);
    },
    register(): void {},
    framesSince(): Array<Record<string, unknown>> {
      return [];
    },
    size: (): number => 0,
    dispose(): void {},
  };
}

/** fake system notifier 调用记录。 */
interface FakeSystemCall {
  pop: boolean;
  tone: SoundSetting;
  title: string;
  message: string;
}

/** fake system notifier（记录调用；notify 返回 Promise 决议——异步终态）。 */
function fakeSystem(opts: { failSoundOnly?: boolean } = {}) {
  const calls: FakeSystemCall[] = [];
  return {
    calls,
    async notify(pop: boolean, tone: SoundSetting, title: string, message: string): Promise<boolean> {
      calls.push({ pop, tone, title, message });
      if (opts.failSoundOnly && pop === false) return false; // 只响不弹自播失败
      return true;
    },
  };
}

/** 注入的系统通知面（fakeSystem 与并发用例共用；play 只经 notify 自播投递决议）。 */
type SystemLike = Pick<ReturnType<typeof fakeSystem>, "notify">;

/** fake history（记录 append）。 */
function fakeHistory() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    append(e: HistoryEntry): void {
      entries.push({ ...e });
    },
    read: async (): Promise<Array<Record<string, unknown>>> => entries,
    clear: async (): Promise<number> => {
      entries.length = 0;
      return 0;
    },
  };
}

/** 构造一个配置镜像（默认全开）。 */
function defaultCfg(overrides: Partial<NotifyConfig> = {}): NotifyConfig {
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
    browserSound: true,
    systemSound: true,
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
    errorMergeWindowMs: 60000,
    askRemindMin: 5,
    doneMergeWindowMs: 3000,
    historyMaxAgeDays: 0,
    maxConnections: 16,
    channels: [],
    kindRoutes: {},
    allowKinds: [],
    sanitizeContent: true,
    ...overrides,
  };
}

/** makeService 的 deps 定制面（未指定项一律走默认 fake）。 */
interface ServiceHooks {
  system?: SystemLike;
  current?: () => NotifyConfig;
  outboundChannels?: () => Array<{ id: string; channel: NotifyChannel }>;
  recordStatus?: (channelId: string, status: "ok" | "failed", error?: string) => void;
  emitSent?: (payload: NotifySentEvent) => void;
  setConfirm?: (kind: string, confirmed: boolean) => void;
  enabled?: () => boolean;
  warn?: (message: string) => void;
  info?: (message: string) => void;
}

/** 完整 deps 装配。 */
function makeService(cfgOverrides: Partial<NotifyConfig> = {}, hooks: ServiceHooks = {}) {
  const sse = fakeSse();
  const system = (hooks.system ?? fakeSystem()) as ReturnType<typeof fakeSystem>;
  const history = fakeHistory();
  const cfg = defaultCfg(cfgOverrides);
  const logger = { warn: hooks.warn ?? (() => {}), info: hooks.info ?? (() => {}) };
  const enabled = hooks.enabled ?? (() => true);
  /** 投递终态收集（recordStatus/emitSent 断言用）。 */
  const terminalStates: Array<{ channelId: string; status: "ok" | "failed"; error?: string }> = [];
  const sentEvents: NotifySentEvent[] = [];
  /** 确认写入收集（confirmKind 走配置）。 */
  const confirmCalls: Array<{ kind: string; confirmed: boolean }> = [];
  // 内置频道经 index.ts 装配面注入——实例只承载 id+capabilities，
  // 播放决议经 DeliverDeps.play 值传递（browser→buildBrowserFrame、system→notify）
  const browserChannel = createBrowserChannel({ sse: sse as unknown as SseHub });
  const systemChannel = createSystemChannel({ system });
  const service = createNotifierService({
    current: hooks.current ?? (() => cfg),
    enabled,
    history,
    logger,
    outboundChannels: hooks.outboundChannels ?? (() => []),
    builtinChannels: [
      { id: BUILTIN_CHANNELS.browser, channel: browserChannel },
      { id: BUILTIN_CHANNELS.system, channel: systemChannel },
    ],
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
    play: (target, payload) => {
      if (target.id === BUILTIN_CHANNELS.system) {
        // 播放决议在裁决时快照解析并随 target 携带（内置频道 id 分派，spec 恒存在）
        const spec = target.dispatch as SystemDispatchSpec;
        return system.notify(spec.pop, spec.sound, payload.title, payload.body).then((ok) => {
          if (!ok) throw new Error("system notification failed (self-play or command error)");
        });
      }
      if (target.id === BUILTIN_CHANNELS.browser) {
        sse.broadcast(buildBrowserFrame(payload, target.dispatch as BrowserDispatchSpec));
      }
      return undefined;
    },
  });
  return { service, sse, system, history, terminalStates, sentEvents, confirmCalls };
}

/** 取最后一帧（无帧即 undefined）。 */
function lastFrame(sse: ReturnType<typeof fakeSse>): Record<string, unknown> {
  return sse.frames[sse.frames.length - 1];
}

// ---------------------------------------------------------------- ① severity 映射

describe("① severity 静态映射覆盖内置七 kind", () => {
  const expected: Record<string, string> = {
    ask: "warning",
    question: "info",
    done: "success",
    "subagent-done": "info",
    error: "failure",
    "turn-end": "info",
    test: "info",
  };

  for (const [kind, severity] of Object.entries(expected)) {
    it(`${kind} → ${severity}`, () => {
      expect((KIND_SEVERITY as Record<string, string>)[kind]).toBe(severity);
    });
  }
});

// ---------------------------------------------------------------- ② send 受理语义

describe("②a enabled=false → skipped", () => {
  it("enabled=false → status skipped", async () => {
    const { service } = makeService({}, { enabled: () => false });
    const r = await service.send({ source: "test", kind: "done", severity: "info", body: "x" });
    expect(r[0].status).toBe("skipped");
  });

  it("enabled=false → error enabled=false", async () => {
    const { service } = makeService({}, { enabled: () => false });
    const r = await service.send({ source: "test", kind: "done", severity: "info", body: "x" });
    expect(r[0].error).toBe("enabled=false");
  });
});

describe("②b 非法形状 → failed（不抛）", () => {
  it("send(null) → failed", async () => {
    const { service } = makeService();
    const r = await service.send(null as unknown as NotifyRequest);
    expect(r[0].status).toBe("failed");
  });

  it("缺 kind → failed", async () => {
    const { service } = makeService();
    const r2 = await service.send({ source: "test", severity: "info", body: "x" } as unknown as NotifyRequest);
    expect(r2[0].status).toBe("failed");
  });
});

describe("②c 内置 kind 走文案管线 + 历史落盘", () => {
  let r: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let frame: Record<string, unknown> | undefined;
  let history: ReturnType<typeof fakeHistory>;

  beforeAll(async () => {
    const made = makeService();
    history = made.history;
    r = await made.service.send({ source: "test", kind: "done", severity: "info", body: "任务完成" });
    frame = made.sse.frames.find((f) => f.type === "notify" && f.kind === "done");
  });

  it("browser 受理 ok", () => {
    expect(r.some((x) => x.channelId === "browser" && x.status === "ok")).toBeTruthy();
  });

  it("browser 收到 done 帧", () => {
    expect(frame !== undefined).toBeTruthy();
  });

  it("模板产物含「已完成」（非 body 原样透传）", () => {
    // 内置 kind 走模板：消息含「已完成」而非 body 原样透传（评审保留文案模板）
    expect(typeof frame!.message === "string" && (frame!.message as string).includes("已完成")).toBeTruthy();
  });

  it("历史落盘含 done", () => {
    expect(history.entries.some((e) => e.kind === "done")).toBeTruthy();
  });
});

describe("B5 SSE 帧 sound 字段（selfplay/system/silent 三态）", () => {
  // SSE 帧附服务端解析的 sound 字段（browser 频道 send 处 resolveBrowserSound；
  // 既有帧契约只加字段向后兼容——旧客户端无 sound 帧回落快照）
  let frame: Record<string, unknown>;
  let frame2: Record<string, unknown>;
  let frame3: Record<string, unknown>;

  beforeAll(async () => {
    const a = makeService({ browserSound: "chime" });
    await a.service.send({ source: "test", kind: "done", severity: "info", body: "x" });
    frame = a.sse.frames.find((f) => f.type === "notify" && f.kind === "done") as Record<string, unknown>;
    const b = makeService({ browserSound: true });
    await b.service.send({ source: "test", kind: "done", severity: "info", body: "x" });
    frame2 = b.sse.frames.find((f) => f.type === "notify" && f.kind === "done") as Record<string, unknown>;
    const c = makeService({ browserSound: false });
    await c.service.send({ source: "test", kind: "done", severity: "info", body: "x" });
    frame3 = c.sse.frames.find((f) => f.type === "notify" && f.kind === "done") as Record<string, unknown>;
  });

  it("B5：notify 帧含 sound 策略（SoundId → selfplay+tone）", () => {
    expect(frame.sound).toEqual({ mode: "selfplay", tone: "chime" });
  });

  it("B5：sound:true → system 模式", () => {
    expect(frame2.sound).toEqual({ mode: "system", tone: undefined });
  });

  it("B5：sound:false → silent 模式", () => {
    expect(frame3.sound).toEqual({ mode: "silent", tone: undefined });
  });
});

// 投递集合条件 = 弹窗开关 || 声音非静音——弹窗关+声音开仍投递（sound-only）；
// 弹窗关+声音关 → 静默不投递
describe("B6 投递集合条件（弹窗||声音）+ 只响不弹", () => {
  let r: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let frame: Record<string, unknown>;
  let system: ReturnType<typeof fakeSystem>;

  beforeAll(async () => {
    const made = makeService({ browserNotify: false, systemNotify: false, browserSound: "pop", systemSound: true });
    system = made.system;
    r = await made.service.send({ source: "test", kind: "done", severity: "info", body: "x" });
    frame = made.sse.frames.find((f) => f.kind === "done") as Record<string, unknown>;
  });

  it("B6：browser 弹窗关+声音开仍投递（sound-only）", () => {
    expect(r.some((x) => x.channelId === "browser" && x.status === "ok")).toBeTruthy();
  });

  it("B6：system 弹窗关+声音开仍投递", () => {
    expect(r.some((x) => x.channelId === "system" && x.status === "ok")).toBeTruthy();
  });

  it("B6：只响不弹帧带 playOnly 标记", () => {
    // browser sound-only 帧：playOnly 标记 + sound 模式（客户端只自播不弹实体）
    expect(frame.playOnly).toBe(true);
  });

  it("B6：只响不弹帧 sound 为 SoundId 自播", () => {
    expect(frame.sound).toEqual({ mode: "selfplay", tone: "pop" });
  });

  it("B6：system 只响不弹 → notify(pop=false, tone=true)", () => {
    // system sound-only：notify(pop=false) 自播调用
    expect(system.calls.some((c) => c.pop === false && c.tone === true)).toBeTruthy();
  });
});

describe("B6 弹窗+声音全关 → 频道不进投递集合", () => {
  let r2: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let sse2: ReturnType<typeof fakeSse>;

  beforeAll(async () => {
    const made = makeService({ browserNotify: false, systemNotify: false, browserSound: false, systemSound: false });
    sse2 = made.sse;
    r2 = await made.service.send({ source: "test", kind: "done", severity: "info", body: "x" });
  });

  it("B6：弹窗+声音全关 → 频道不进投递集合", () => {
    expect(!r2.some((x) => x.channelId === "browser" || x.channelId === "system")).toBeTruthy();
  });

  it("B6：全关无 SSE 帧", () => {
    expect(sse2.frames.length).toBe(0);
  });
});

// 快照化（红测先行判别更新）：每次 sendKind 恰好读取 current() 1 次
// （单刻快照，行为变更）；裁决（enabled/确认/免打扰/路由）与播放决议全部
// 基于该快照解析——裁决与投递之间改配置不影响本次投递（另有用例锁定）；脱敏开关
// 也经该快照解析并随裁决结果携带（不引入第二次 current()）。
describe("B-2 单刻快照（首次 sendKind）", () => {
  let reads: number;
  let frame1: { sound: { mode: string } };

  beforeAll(() => {
    reads = 0;
    let cfg = defaultCfg({ browserNotify: true, browserSound: true, systemNotify: true, systemSound: true });
    const sys = fakeSystem();
    const { service, sse } = makeService({}, { current: () => { reads += 1; return cfg; }, system: sys });
    service.sendKind("test", {}, { bypassQuiet: true });
    frame1 = sse.frames[sse.frames.length - 1] as { sound: { mode: string } };
  });

  it("B-2：单次 sendKind 内 current() 恰好 1 次（单刻快照）", () => {
    expect(reads).toBe(1);
  });

  it("B-2：browserSound=true → system 模式帧（快照内解析）", () => {
    expect(frame1.sound.mode).toBe("system");
  });
});

describe("B-2 单刻快照（跨次不缓存 + 热更即时生效）", () => {
  let reads: number;
  let frame2: { sound: { mode: string } };

  beforeAll(() => {
    reads = 0;
    let cfg = defaultCfg({ browserNotify: true, browserSound: true, systemNotify: true, systemSound: true });
    const sys = fakeSystem();
    const { service, sse } = makeService({}, { current: () => { reads += 1; return cfg; }, system: sys });
    service.sendKind("test", {}, { bypassQuiet: true });
    // 配置热更 → 下次 sendKind 重新取快照（跨次不缓存）且用新版本
    cfg = defaultCfg({ browserNotify: true, browserSound: false, systemNotify: true, systemSound: true });
    service.sendKind("test", {}, { bypassQuiet: true });
    frame2 = sse.frames[sse.frames.length - 1] as { sound: { mode: string } };
  });

  it("B-2：第二次 sendKind 重新读取 current（跨次不缓存）", () => {
    expect(reads).toBe(2);
  });

  it("B-2：browserSound=false → silent 模式帧（热更即时生效）", () => {
    expect(frame2.sound.mode).toBe("silent");
  });
});

describe("N-18 裁决→投递间改配置不影响本次投递", () => {
  // 快照化（服务契约面）：裁决→投递间改配置不影响本次投递——current 首次返回
  // cfg1、之后返回 cfg2（模拟裁决后配置即被改写）；本次投递的集合判定与播放
  // 决议必须全部来自裁决时刻的 cfg1 快照，不得混入 cfg2。
  let calls: number;
  let r: ReturnType<ReturnType<typeof makeService>["service"]["sendKind"]>;
  let frame: Record<string, unknown>;

  beforeAll(() => {
    calls = 0;
    const cfg1 = defaultCfg({ browserNotify: true, browserSound: "chime", systemNotify: true, systemSound: true });
    const cfg2 = defaultCfg({ browserNotify: true, browserSound: false, systemNotify: false, systemSound: false });
    const sys = fakeSystem();
    const { service, sse } = makeService({}, {
      current: () => { calls += 1; return calls === 1 ? cfg1 : cfg2; },
      system: sys,
    });
    r = service.sendKind("test", {}, { bypassQuiet: true });
    frame = sse.frames[sse.frames.length - 1];
  });

  it("N-18：裁决恰好读取 1 次快照（无二次读取）", () => {
    expect(calls).toBe(1);
  });

  it("N-18：播放决议来自裁决时刻快照（cfg1 的 chime），未被 cfg2 改写", () => {
    expect(frame.sound).toEqual({ mode: "selfplay", tone: "chime" });
  });

  it("N-18：system 仍按 cfg1 快照投递（cfg2 关掉 system 不影响本次）", () => {
    expect(r.some((x) => x.channelId === "system" && x.status === "ok")).toBeTruthy();
  });
});

// send() 动态 kind 与 sendKind 统一过裁决全链——
// enabled=false / 免打扰期间动态 kind 从「照常投递」变 skipped（行为变更登记；
// 现状 sdk/service.ts:165-197 绕过 enabled 与免打扰，红测锁定后改）。
describe("N-25 enabled=false 动态 kind 统一过裁决", () => {
  let rA: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let sseA: ReturnType<typeof fakeSse>;
  let histA: ReturnType<typeof fakeHistory>;

  beforeAll(async () => {
    const made = makeService({}, { enabled: () => false });
    sseA = made.sse;
    histA = made.history;
    made.service.registerKind({ id: "demo:off", label: "OFF" });
    made.service.confirmKind("demo:off", true);
    rA = await made.service.send({ source: "@example/demo", kind: "demo:off", severity: "info", body: "y" });
  });

  it("N-25：enabled=false 动态 kind → skipped", () => {
    expect(rA[0].status).toBe("skipped");
  });

  it("N-25：enabled=false 动态 kind → error enabled=false", () => {
    expect(rA[0].error).toBe("enabled=false");
  });

  it("N-25：enabled=false 动态 kind 不触达任何频道", () => {
    expect(sseA.frames.length).toBe(0);
  });

  it("N-25：disabled 不落史（D15 保持）", () => {
    expect(!histA.entries.some((e) => e.kind === "demo:off")).toBeTruthy();
  });
});

describe("N-25 免打扰期间动态 kind 统一过裁决", () => {
  let rB: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let sseB: ReturnType<typeof fakeSse>;
  let histB: ReturnType<typeof fakeHistory>;

  beforeAll(async () => {
    // 免打扰期间（动态 kind 未豁免）
    const made = makeService({ quietHours: quietWindowNow() });
    sseB = made.sse;
    histB = made.history;
    made.service.registerKind({ id: "demo:q", label: "Q" });
    made.service.confirmKind("demo:q", true);
    rB = await made.service.send({ source: "@example/demo", kind: "demo:q", severity: "info", body: "z" });
  });

  it("N-25：免打扰期间动态 kind → skipped", () => {
    expect(rB[0].status).toBe("skipped");
  });

  it("N-25：免打扰期间动态 kind → error quiet", () => {
    expect(rB[0].error).toBe("quiet");
  });

  it("N-25：免打扰期间动态 kind 不触达", () => {
    expect(sseB.frames.length).toBe(0);
  });

  it("N-25：免打扰 suppressed 落史", () => {
    expect(histB.entries.some((e) => e.kind === "demo:q" && e.suppressed === "quiet")).toBeTruthy();
  });
});

describe("P1-3 并发 sendKind 不串快照", () => {
  // 生命周期条款：两个并发 sendKind 不串快照——current 按调用序返回不同
  // 配置，各自的裁决/投递必须用各自快照，互不污染；第一次的异步终态在第二次
  // 之后决议，仍按第一次的快照决议与载荷上报。
  let calls: number;
  let d0: { pop: boolean; tone: SoundSetting };
  let d1: { pop: boolean; tone: SoundSetting };
  let ev: NotifySentEvent | undefined;

  beforeAll(async () => {
    calls = 0;
    const cfgA = defaultCfg({ browserNotify: false, browserSound: false, systemNotify: true, systemSound: "ding" });
    const cfgB = defaultCfg({ browserNotify: false, browserSound: false, systemNotify: true, systemSound: "bell" });
    const deferred: Array<{ resolve: (value: boolean) => void; pop: boolean; tone: SoundSetting; title: string; message: string }> = [];
    const sys: SystemLike = {
      notify(pop, tone, title, message) {
        return new Promise<boolean>((resolve) => deferred.push({ resolve, pop, tone, title, message }));
      },
    };
    const { service, terminalStates, sentEvents } = makeService(
      { browserNotify: false, browserSound: false, systemNotify: true, systemSound: true },
      { current: () => { calls += 1; return calls === 1 ? cfgA : cfgB; }, system: sys },
    );
    service.sendKind("test", {}, { bypassQuiet: true }); // 第一次：快照 = cfgA
    service.sendKind("test", {}, { bypassQuiet: true }); // 第二次：快照 = cfgB（第一次终态未决议）
    d0 = { pop: deferred[0].pop, tone: deferred[0].tone };
    d1 = { pop: deferred[1].pop, tone: deferred[1].tone };
    deferred[0].resolve(true);
    await pollUntil(() => terminalStates.some((s) => s.channelId === "system"));
    ev = sentEvents.find((e) => e.channelId === "system");
  });

  it("P1-3：两次 sendKind 各取一次快照", () => {
    expect(calls).toBe(2);
  });

  it("P1-3：第一次投递按 cfgA 快照决议（tone=ding）", () => {
    expect(d0).toEqual({ pop: true, tone: "ding" });
  });

  it("P1-3：第二次投递按 cfgB 快照决议（tone=bell，不串）", () => {
    expect(d1).toEqual({ pop: true, tone: "bell" });
  });

  it("P1-3：第一次终态按自身载荷上报（不受第二次影响）", () => {
    expect(ev && ev.status === "ok" && ev.message.includes("通知链路工作正常")).toBeTruthy();
  });
});

describe("P1-1 playOnly + browserSound:true → selfplay 帧编码", () => {
  // 复核：弹窗关 + browserSound=true（默认值）的 playOnly 帧必须编码为
  // selfplay（tone undefined = 客户端默认旋律）——原 mode:"system" 会让客户端
  // 既不弹也不播 → 纯静默误导（弹窗关 = 无 OS 通知实体 = OS 不会发声）
  let r: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let frame: Record<string, unknown>;

  beforeAll(async () => {
    const made = makeService({ browserNotify: false, systemNotify: false, browserSound: true, systemSound: false });
    r = await made.service.send({ source: "test", kind: "done", severity: "info", body: "x" });
    frame = made.sse.frames.find((f) => f.kind === "done") as Record<string, unknown>;
  });

  it("P1-1：browser 弹窗关+true 仍投递（sound-only）", () => {
    expect(r.some((x) => x.channelId === "browser" && x.status === "ok")).toBeTruthy();
  });

  it("P1-1：playOnly 帧标记", () => {
    expect(frame.playOnly).toBe(true);
  });

  it("P1-1：true → selfplay + tone undefined（默认旋律，非 system）", () => {
    expect(frame.sound).toEqual({ mode: "selfplay", tone: undefined });
  });
});

describe("B4 只响不弹自播失败 → 异步终态 failed", () => {
  // 只响不弹自播失败 → 异步终态 failed（status + sent 事件诚实上报，
  // 不做「静默成功」）；deliver promise 拒收路径
  let r: ReturnType<ReturnType<typeof makeService>["service"]["sendKind"]>;
  let st: { channelId: string; status: "ok" | "failed"; error?: string } | undefined;
  let ev: NotifySentEvent | undefined;

  beforeAll(async () => {
    const sys = fakeSystem({ failSoundOnly: true });
    const { service, terminalStates, sentEvents } = makeService(
      { browserNotify: false, browserSound: false, systemNotify: false, systemSound: true },
      { system: sys },
    );
    r = service.sendKind("test", {}, { bypassQuiet: true });
    await pollUntil(() => terminalStates.some((s) => s.channelId === "system"));
    st = terminalStates.find((s) => s.channelId === "system");
    ev = sentEvents.find((e) => e.channelId === "system");
  });

  it("B4：受理仍 ok（铁律 1：受理与终态解耦）", () => {
    expect(r.some((x) => x.channelId === "system" && x.status === "ok")).toBeTruthy();
  });

  it("B4：只响不弹自播失败 → status failed", () => {
    expect(st && st.status === "failed").toBeTruthy();
  });

  it("B4：sent 事件带 failed 终态", () => {
    expect(ev && ev.status === "failed").toBeTruthy();
  });
});

// ---------------------------------------------------------------- ③ 动态 kind 待确认

describe("③a 待确认 → suppressed 落史零触达", () => {
  let r: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let sse: ReturnType<typeof fakeSse>;
  let history: ReturnType<typeof fakeHistory>;

  beforeAll(async () => {
    // 未确认 → suppressed 落史，零触达
    const made = makeService();
    sse = made.sse;
    history = made.history;
    made.service.registerKind({ id: "demo:ready", label: "示例事务就绪" });
    r = await made.service.send({ source: "@example/demo-consumer", kind: "demo:ready", severity: "info", body: "3 个事务就绪" });
  });

  it("待确认 kind → skipped", () => {
    expect(r[0].status).toBe("skipped");
  });

  it("待确认 kind → error kind-pending", () => {
    expect(r[0].error).toBe("kind-pending");
  });

  it("待确认 kind 不得触达频道", () => {
    expect(sse.frames.length).toBe(0);
  });

  it("待确认 kind suppressed:kind-pending 落史", () => {
    expect(history.entries.some((e) => e.suppressed === "kind-pending")).toBeTruthy();
  });
});

describe("③b confirmKind 后放行", () => {
  let r: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let sse: ReturnType<typeof fakeSse>;

  beforeAll(async () => {
    const made = makeService();
    sse = made.sse;
    made.service.registerKind({ id: "demo:ready", label: "示例事务就绪" });
    made.service.confirmKind("demo:ready", true);
    r = await made.service.send({ source: "@example/demo-consumer", kind: "demo:ready", severity: "info", body: "3 个事务就绪" });
  });

  it("confirmKind 后受理 ok", () => {
    expect(r.some((x) => x.status === "ok")).toBeTruthy();
  });

  it("confirmKind 后触达频道", () => {
    expect(sse.frames.some((f) => f.kind === "demo:ready")).toBeTruthy();
  });
});

describe("③c listKinds 反映确认态", () => {
  it("未确认时 confirmed=false", () => {
    const { service } = makeService();
    service.registerKind({ id: "x:y", label: "Y" });
    expect(service.listKinds()[0].confirmed).toBe(false);
  });

  it("确认后 confirmed=true", () => {
    const { service } = makeService();
    service.registerKind({ id: "x:y", label: "Y" });
    service.confirmKind("x:y", true);
    expect(service.listKinds()[0].confirmed).toBe(true);
  });
});

// ---------------------------------------------------------------- ④ registerKind 防冒认

describe("④ registerKind 防冒认", () => {
  it("无 ':' 前缀拒绝", () => {
    const { service } = makeService();
    service.registerKind({ id: "naked", label: "N" });
    expect(service.listKinds().length).toBe(0);
  });

  it("前缀为内置 kind 名拒绝", () => {
    const { service } = makeService();
    service.registerKind({ id: "naked", label: "N" });
    service.registerKind({ id: "done:extra", label: "D" });
    expect(service.listKinds().length).toBe(0);
  });

  it("合法动态 id 接受", () => {
    const { service } = makeService();
    service.registerKind({ id: "naked", label: "N" });
    service.registerKind({ id: "done:extra", label: "D" });
    service.registerKind({ id: "idle-archive:due", label: "D" });
    expect(service.listKinds().length).toBe(1);
  });
});

// ---------------------------------------------------------------- ⑤ fail-soft 逐频道

describe("⑤ 频道开关路由生效（browser 全关 → 只走 system）", () => {
  let r: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let sse: ReturnType<typeof fakeSse>;

  beforeAll(async () => {
    // 关闭 browser 弹窗且声音也关、只留 system：dispatch 只走 system
    const made = makeService({ browserNotify: false, browserSound: false, systemNotify: true });
    sse = made.sse;
    r = await made.service.send({ source: "test", kind: "error", severity: "failure", body: "boom" });
  });

  it("system 受理 ok", () => {
    expect(r.some((x) => x.channelId === "system" && x.status === "ok")).toBeTruthy();
  });

  it("browser 不在投递集合", () => {
    expect(!r.some((x) => x.channelId === "browser")).toBeTruthy();
  });

  it("browser 弹窗与声音全关时不投递", () => {
    expect(sse.frames.length).toBe(0);
  });
});

// ---------------------------------------------------------------- fake 出站频道

/** fake 出站频道（bark 形态）：记录投递，可指定同步/异步终态。 */
function fakeOutbound(id: string, mode: "sync" | "reject" = "sync") {
  const sent: DeliverPayload[] = [];
  return {
    sent,
    entry: {
      id,
      channel: {
        name: id,
        capabilities: { titleMaxLen: 64, maxBodyLen: 256 },
        send(p: DeliverPayload): void | Promise<void> {
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

/** ⑥ 用 fetch 桩（URL 前缀过滤；白名单外直通原始实现）。 */
type FetchStubCall = { url: string | URL | Request; init: { body: string } };

function installFetchStub(handler: (url: string | URL | Request, init?: RequestInit) => Promise<unknown> | unknown) {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => handler(url, init)) as unknown as typeof fetch;
  return () => { globalThis.fetch = origFetch; };
}

describe("⑥ bark payload/level 映射/levels 矩阵/透传", () => {
  let calls: FetchStubCall[];
  let isPromise: boolean;
  let bodies: Array<Record<string, unknown>>;

  beforeAll(async () => {
    const origFetch = globalThis.fetch;
    calls = [];
    try {
      // URL 过滤：只拦截本块目标，避免污染/被污染（同进程其他在途 fetch 直通原始实现）
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (!String(url).startsWith("http://127.0.0.1:40280/")) return origFetch(url, init);
        calls.push({ url, init: init as { body: string } });
        return { ok: true, status: 200, json: async () => ({ code: 200, message: "success" }), text: async () => "" };
      }) as unknown as typeof fetch;

      // volume 为 Bark 前向兼容的未知透传键（BarkChannelConfig 只声明已知可选参数）
      const cfg: BarkChannelConfig & { volume: string } = { id: "phone", type: "bark", baseUrl: "http://127.0.0.1:40280", deviceKey: "SECRETKEY22", enabled: true, sound: "minuet", group: "dsh", volume: "0.8" };
      const ch = createBarkChannel(cfg);
      const p = ch.send({ title: "T", body: "B", kind: "error", ts: 123, severity: "failure" }) as Promise<void> | undefined;
      isPromise = !!p && typeof p.then === "function";
      await p;
      await ch.send({ title: "T", body: "B", kind: "test", ts: 1, severity: "info" });
      const ch2 = createBarkChannel({ ...cfg, level: "critical" });
      await ch2.send({ title: "T", body: "B", kind: "error", ts: 2, severity: "failure" });
      // levels（kind→level 稀疏映射矩阵）：优先级 levels[kind] > level > severity 映射
      const ch3 = createBarkChannel({ ...cfg, level: "critical", levels: { error: "timeSensitive", question: "active" } });
      await ch3.send({ title: "T", body: "B", kind: "error", ts: 3, severity: "failure" });
      await ch3.send({ title: "T", body: "B", kind: "question", ts: 4, severity: "info" });
      await ch3.send({ title: "T", body: "B", kind: "done", ts: 5, severity: "success" });
      // severity 缺失 + levels 命中 → 有 level；severity 缺失 + levels 未命中 → body 无 level
      await ch3.send({ title: "T", body: "B", kind: "question", ts: 6 });
      const ch4 = createBarkChannel(cfg);
      await ch4.send({ title: "T", body: "B", kind: "question", ts: 7 });
      // 动态 kind 键（含特殊字符）作 levels 键正常命中
      const ch5 = createBarkChannel({ ...cfg, levels: { "idle-archive:due": "timeSensitive" } });
      await ch5.send({ title: "T", body: "B", kind: "idle-archive:due", ts: 8, severity: "info" });
      bodies = calls.map((c) => JSON.parse(c.init.body));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("SEVERITY_LEVEL.failure = timeSensitive", () => {
    expect(SEVERITY_LEVEL.failure).toBe("timeSensitive");
  });

  it("SEVERITY_LEVEL.warning = active", () => {
    expect(SEVERITY_LEVEL.warning).toBe("active");
  });

  it("SEVERITY_LEVEL.success = active", () => {
    expect(SEVERITY_LEVEL.success).toBe("active");
  });

  it("SEVERITY_LEVEL.info = passive", () => {
    expect(SEVERITY_LEVEL.info).toBe("passive");
  });

  it("send 返回在途 promise", () => {
    expect(isPromise).toBeTruthy();
  });

  it("POST baseUrl+/push；device key 不在 URL", () => {
    expect(calls[0].url).toBe("http://127.0.0.1:40280/push");
  });

  it("device_key 走 body", () => {
    expect(bodies[0].device_key).toBe("SECRETKEY22");
  });

  it("body.title 透传", () => {
    expect(bodies[0].title).toBe("T");
  });

  it("body.body 透传", () => {
    expect(bodies[0].body).toBe("B");
  });

  it("failure → timeSensitive", () => {
    expect(bodies[0].level).toBe("timeSensitive");
  });

  it("body.sound 透传", () => {
    expect(bodies[0].sound).toBe("minuet");
  });

  it("body.group 透传", () => {
    expect(bodies[0].group).toBe("dsh");
  });

  it("未知参数透传（Bark 前向兼容）", () => {
    expect(bodies[0].volume).toBe("0.8");
  });

  it("info → passive", () => {
    expect(bodies[1].level).toBe("passive");
  });

  it("显式 level 覆盖映射", () => {
    expect(bodies[2].level).toBe("critical");
  });

  it("levels[kind] 优先于实例级 level", () => {
    expect(bodies[3].level).toBe("timeSensitive");
  });

  it("levels[kind] 命中（question→active）", () => {
    expect(bodies[4].level).toBe("active");
  });

  it("levels 未命中 kind 回退实例级 level", () => {
    expect(bodies[5].level).toBe("critical");
  });

  it("levels 矩阵不进 Bark body（防配置泄漏 P0）", () => {
    expect("levels" in bodies[5]).toBe(false);
  });

  it("severity 缺失 + levels 命中仍出 level", () => {
    expect(bodies[6].level).toBe("active");
  });

  it("severity 缺失且无覆盖 → body 无 level", () => {
    expect("level" in bodies[7]).toBe(false);
  });

  it("动态 kind 键命中", () => {
    expect(bodies[8].level).toBe("timeSensitive");
  });
});

// 失败路径（重试/并发门上移后）：channel 单次投递 + 错误协议标注——4xx 确定失败
// （retryable:false）且脱敏；5xx 可重试（retryable:true）。重试 ×2 与退避
// 由框架 deliver 承载，直测见 unit-pipeline-contract 与 e2e-outbound。
describe("⑥b bark 4xx 不重试 + 脱敏", () => {
  let n: number;
  let lastErr: RetryableError;

  beforeAll(async () => {
    const origFetch = globalThis.fetch;
    try {
      n = 0;
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (!String(url).startsWith("https://h/")) return origFetch(url);
        n += 1;
        return { ok: false, status: 400, json: async () => ({}), text: async () => "failed to get [SECRETKEY22] device token from database" };
      }) as unknown as typeof fetch;
      const ch = createBarkChannel({ id: "p", type: "bark", baseUrl: "https://h", deviceKey: "SECRETKEY22", enabled: true });
      lastErr = await sendFailure(ch.send({ title: "T", body: "B", kind: "test", ts: 1 }));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("4xx 确定失败不重试", () => {
    expect(n).toBe(1);
  });

  it("错误含响应摘要", () => {
    expect(lastErr.message.includes("device token")).toBeTruthy();
  });

  it("错误文本无 device key 明文（评审 P0-4）", () => {
    expect(!lastErr.message.includes("SECRETKEY22")).toBeTruthy();
  });

  it("4xx → retryable:false（框架据此不重试）", () => {
    expect(lastErr.retryable).toBe(false);
  });
});

describe("⑥b bark 5xx retryable 标注", () => {
  let attempts: number;
  let lastErr: RetryableError;

  beforeAll(async () => {
    const origFetch = globalThis.fetch;
    try {
      attempts = 0;
      globalThis.fetch = (async (url: string | URL | Request) => {
        if (!String(url).startsWith("https://h/")) return origFetch(url);
        attempts += 1;
        return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
      }) as unknown as typeof fetch;
      const ch = createBarkChannel({ id: "p", type: "bark", baseUrl: "https://h", deviceKey: "SECRETKEY22", enabled: true });
      lastErr = await sendFailure(ch.send({ title: "T", body: "B", kind: "test", ts: 2 }));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("5xx 单次投递即失败（channel 不重试，重试是框架职责）", () => {
    expect(attempts).toBe(1);
  });

  it("5xx → retryable:true（框架据此重试）", () => {
    expect(lastErr.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------- ⑦ 路由解析三条契约

const chanCfg: BarkChannelConfig[] = [
  { id: "phone", type: "bark", baseUrl: "https://h", deviceKey: "k1", enabled: true },
  { id: "pad", type: "bark", baseUrl: "https://h", deviceKey: "k2", enabled: true },
];

describe("⑦ 缺省广播：kindRoutes 无条目 → 内置 + 出站全收", () => {
  let r1: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;

  beforeAll(async () => {
    const phone = fakeOutbound("bark:phone");
    const pad = fakeOutbound("bark:pad");
    const svc1 = makeService({ channels: chanCfg }, { outboundChannels: () => [phone.entry, pad.entry] });
    r1 = await svc1.service.send({ source: "t", kind: "error", severity: "failure", body: "x" });
  });

  it("缺省广播含出站频道", () => {
    expect(r1.some((x) => x.channelId === "bark:phone" && x.status === "ok")).toBeTruthy();
  });

  it("缺省广播含内置频道", () => {
    expect(r1.some((x) => x.channelId === "browser")).toBeTruthy();
  });
});

describe("⑦ 稀疏命中：条目只列 bark:phone → 只投该频道", () => {
  let r2: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;

  beforeAll(async () => {
    const phone = fakeOutbound("bark:phone");
    const pad = fakeOutbound("bark:pad");
    const svc2 = makeService({ channels: chanCfg, kindRoutes: { error: ["bark:phone"] } }, { outboundChannels: () => [phone.entry, pad.entry] });
    r2 = await svc2.service.send({ source: "t", kind: "error", severity: "failure", body: "x" });
  });

  it("稀疏条目投递列出的频道", () => {
    expect(r2.some((x) => x.channelId === "bark:phone" && x.status === "ok")).toBeTruthy();
  });

  it("稀疏条目排除未列频道", () => {
    expect(!r2.some((x) => x.channelId === "browser")).toBeTruthy();
  });

  it("稀疏条目排除未列出的出站频道", () => {
    expect(!r2.some((x) => x.channelId === "bark:pad")).toBeTruthy();
  });
});

describe("⑦ 陈旧路由：指向已删除频道 → skipped，不影响其他目标", () => {
  let r3: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let staleEntry: { channelId: string; status: string; error?: string } | undefined;

  beforeAll(async () => {
    const phone = fakeOutbound("bark:phone");
    const svc3 = makeService({ channels: chanCfg, kindRoutes: { error: ["bark:gone", "bark:phone"] } }, { outboundChannels: () => [phone.entry] });
    r3 = await svc3.service.send({ source: "t", kind: "error", severity: "failure", body: "x" });
    staleEntry = r3.find((x) => x.channelId === "bark:gone");
  });

  it("陈旧频道有独立受理条目", () => {
    expect(staleEntry).toBeTruthy();
  });

  it("陈旧条目 status skipped", () => {
    expect(staleEntry!.status).toBe("skipped");
  });

  it("陈旧条目 error stale-route", () => {
    expect(staleEntry!.error).toBe("stale-route");
  });

  it("陈旧不影响其他目标", () => {
    expect(r3.some((x) => x.channelId === "bark:phone" && x.status === "ok")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- ⑧ per-channel 测试 + 终态上报

describe("⑧ per-channel 测试（onlyChannel）+ 终态上报", () => {
  let r: ReturnType<ReturnType<typeof makeService>["service"]["sendKind"]>;
  let terminalStates: ReturnType<typeof makeService>["terminalStates"];
  let sentEvents: NotifySentEvent[];

  beforeAll(async () => {
    const phone = fakeOutbound("bark:phone");
    const bad = fakeOutbound("bark:bad", "reject");
    const svc = makeService(
      { channels: [{ id: "phone", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true }] },
      { outboundChannels: () => [phone.entry, bad.entry] },
    );
    terminalStates = svc.terminalStates;
    sentEvents = svc.sentEvents;
    // onlyChannel：单频道受理，内置频道排除
    r = svc.service.sendKind("test", {}, { bypassQuiet: true, onlyChannel: "bark:phone" });
    // fake 频道终态经 promise 微任务回调——轮询到账再断言 status/sent
    await pollUntil(() => svc.terminalStates.some((s) => s.channelId === "bark:phone"));
  });

  it("onlyChannel 命中单频道", () => {
    expect(r.some((x) => x.channelId === "bark:phone" && x.status === "ok")).toBeTruthy();
  });

  it("per-channel 测试排除其他频道", () => {
    expect(!r.some((x) => x.channelId === "browser")).toBeTruthy();
  });

  it("投递成功落 status", () => {
    expect(terminalStates.some((s) => s.channelId === "bark:phone" && s.status === "ok")).toBeTruthy();
  });

  it("投递成功发 sent 事件", () => {
    expect(sentEvents.some((e) => e.channelId === "bark:phone" && e.status === "ok" && e.kind === "test")).toBeTruthy();
  });
});

describe("⑧ 异步终态失败：promise reject → status failed + 事件带脱敏错误", () => {
  let r2: Awaited<ReturnType<ReturnType<typeof makeService>["service"]["send"]>>;
  let badState: { channelId: string; status: "ok" | "failed"; error?: string } | undefined;
  let badEvent: NotifySentEvent | undefined;

  beforeAll(async () => {
    const phone = fakeOutbound("bark:phone");
    const bad = fakeOutbound("bark:bad", "reject");
    const svc = makeService(
      { channels: [{ id: "phone", type: "bark", baseUrl: "https://h", deviceKey: "k", enabled: true }] },
      { outboundChannels: () => [phone.entry, bad.entry] },
    );
    svc.service.sendKind("test", {}, { bypassQuiet: true, onlyChannel: "bark:phone" });
    await pollUntil(() => svc.terminalStates.some((s) => s.channelId === "bark:phone"));
    r2 = await svc.service.send({ source: "t", kind: "error", severity: "failure", body: "x" });
    await pollUntil(() => svc.terminalStates.some((s) => s.channelId === "bark:bad"));
    badState = svc.terminalStates.find((s) => s.channelId === "bark:bad");
    badEvent = svc.sentEvents.find((e) => e.channelId === "bark:bad");
  });

  it("受理与终态解耦（铁律 1）", () => {
    expect(r2.some((x) => x.channelId === "bark:bad" && x.status === "ok")).toBeTruthy();
  });

  it("异步失败落 status", () => {
    expect(badState).toBeTruthy();
  });

  it("异步失败 status failed", () => {
    expect(badState!.status).toBe("failed");
  });

  it("失败摘要含响应信息（过 deliver 层 sanitizeErrorText）", () => {
    expect((badState!.error as string).includes("device token")).toBeTruthy();
  });

  it("sent 事件带失败终态", () => {
    expect(badEvent && badEvent.status === "failed" && badEvent.error).toBeTruthy();
  });
});
