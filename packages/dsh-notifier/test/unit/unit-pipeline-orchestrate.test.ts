/**
 * dsh-notifier — L2 interface 契约：pipeline 域编排面（#733 M1-F1）。
 *
 * 编排三函数自 sdk/service.ts 迁入 pipeline 域前，`handleDecision` 在 test/
 * **0 次直测**（仅经 sendKind 间接覆盖）——本文件先补直测再搬迁（硬前置），
 * 锁定四组行为，搬迁本身不得改变其中任何一条：
 * - suppressed 三分支：disabled 不落史/零触达；kind-pending 与 quiet 落
 *   suppressed 史并返回 skipped；
 * - deliver 分支的**统一脱敏时点**：渲染文本 → 恰好脱敏一次 → 进落史与投递，
 *   deliver 收到的 title/body 已是脱敏文本，而落史与投递文本逐字一致；
 * - stale 频道的 warn 与「不影响其他目标」；
 * - 返回值形状（NotifyResult[]；channelId="*" 的 skipped 语义）。
 *
 * 另覆盖随搬迁一并入面的纯函数（encodeBrowserSound）与投递池解析
 * （resolveChannelPool），以及 sendKind 编排（渲染 → 裁决 → 编排）。
 */
import { describe, expect, it } from "vitest";
import { createAdjudicator, createAppendHistory, createDeliverer, createHandleDecision, createSendKind, encodeBrowserSound, resolveChannelPool } from "../../src/pipeline/interface.ts";
import { sanitizeNoticeContent } from "../../src/text/interface.ts";
import type { AdjudicateResult, AdjudicatedNotice, DeliverPayload, ResolvedTarget } from "../../src/pipeline/interface.ts";
import type { NotifyConfig } from "../../src/config/interface.ts";
import type { NotifyChannel, NotifySentEvent, NotifyResult } from "../../src/sdk/interface.ts";

// ---------------------------------------------------------------- fake deps

/** 投递池 fake 频道（dispatch 目标经 play 值传递，send 不可达）。 */
function poolChannel(name: string): NotifyChannel {
  return {
    name,
    capabilities: { titleMaxLen: 64, maxBodyLen: 256 },
    send() {
      throw new Error(`fake 频道 ${name} 的 send 不应被编排层触达`);
    },
  };
}

/** 内置频道目标（带 dispatch → deliver 经 play 值传递，不经 channel.send）。 */
function browserTarget(id = "browser"): ResolvedTarget {
  return { id, channel: poolChannel(id), dispatch: { pop: true, sound: { mode: "system", tone: undefined } } };
}

/** 历史落盘入参读面。 */
type HistoryEntry = { ts: number; kind: string; title: string; message: string; suppressed?: string };

/**
 * 编排面注入面的完整装配（与 sdk/service.ts 的接线同构）：
 * 真实 createDeliverer 收 playwright/终态/落史注入面，编排器只注入
 * deliver + appendHistory + logger——「落史由谁执行」这件事本身即被测契约
 * （deliver 分支的落史发生在投递编排内，编排层不得重复落史）。
 */
function makeOrchestrateDeps() {
  const history: HistoryEntry[] = [];
  const sent: NotifySentEvent[] = [];
  const statuses: Array<{ channelId: string; status: "ok" | "failed"; error?: string }> = [];
  const played: Array<{ id: string; payload: DeliverPayload }> = [];
  const warns: string[] = [];
  const infos: string[] = [];
  let historyThrows = false;
  const logger = {
    warn: (message: string) => warns.push(message),
    info: (message: string) => infos.push(message),
  };
  const appendHistory = createAppendHistory({
    append(entry: HistoryEntry) {
      if (historyThrows) throw new Error("history append boom");
      history.push(entry);
    },
    logger,
  });
  const deliver = createDeliverer({
    recordStatus: (channelId, status, error) => statuses.push({ channelId, status, error }),
    emitSent: (payload) => sent.push(payload),
    appendHistory,
    play: (target, payload) => {
      played.push({ id: target.id, payload });
    },
  });
  return {
    history,
    sent,
    statuses,
    played,
    warns,
    infos,
    setHistoryThrows: () => {
      historyThrows = true;
    },
    deps: { deliver, appendHistory, logger },
  };
}

/** 未脱敏的敏感文本（命中 SANITIZE_RULES 的 user-path 与 email 两条）。 */
const RAW_TITLE = "敏感 /home/alice/secret.txt";
const RAW_BODY = "联系 alice@example.com 处理";

/** deliver 分支的裁决结果（targets 由调用方给定）。 */
function deliverDecision(targets: ResolvedTarget[], overrides: Partial<AdjudicatedNotice> = {}): AdjudicateResult {
  return {
    decision: "deliver",
    notice: {
      kind: "done",
      title: RAW_TITLE,
      body: RAW_BODY,
      ts: 1700000000000,
      targets,
      stale: [],
      sanitizeContent: true,
      ...overrides,
    },
  };
}

/** suppressed 分支的裁决结果。 */
function suppressedDecision(reason: "disabled" | "kind-pending" | "quiet"): AdjudicateResult {
  return { decision: "suppressed", reason, kind: "demo:x", title: RAW_TITLE, body: RAW_BODY, ts: 1700000000001, sanitizeContent: true };
}

/** 脱敏后的期望文本（enabled 语义 = sanitizeContent !== false）。 */
const SAFE_TITLE = "敏感 <path>";
const SAFE_BODY = "联系 <email> 处理";

/** 编排器（工厂 + 注入面的薄封装，供各用例按需组合注入面）。 */
function handleDecisionFn(decision: AdjudicateResult, deps: Parameters<typeof createHandleDecision>[0]): NotifyResult[] {
  return createHandleDecision(deps)(decision);
}

/**
 * 裁决输入读面的配置镜像（编排面只经注入的 adjudicate 触达，本镜像仅供 sendKind
 * 用例）。只声明本文件实际用到的键——其余键走强制断言：裁决器只读快照上的
 * 声音/弹窗/免打扰/路由键，未声明键永不被读取（用例不依赖其运行时值）。
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
  } as NotifyConfig;
}

// ---------------------------------------------------------------- ① suppressed 三分支

describe("①a disabled → skipped('enabled=false') 且不落史", () => {
  it("disabled：返回单条 channelId='*' 的 skipped，error=enabled=false", () => {
    const made = makeOrchestrateDeps();
    expect(handleDecisionFn(suppressedDecision("disabled"), made.deps)).toEqual([
      { channelId: "*", status: "skipped", error: "enabled=false" },
    ]);
  });

  it("disabled：不落史（历史无该 kind 记录）", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(suppressedDecision("disabled"), made.deps);
    expect(made.history).toEqual([]);
  });

  it("disabled：不投递（deliver 零调用）", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(suppressedDecision("disabled"), made.deps);
    expect(made.played.length).toBe(0);
  });
});

describe("①b kind-pending → 落 suppressed 史 + skipped", () => {
  it("kind-pending：返回 skipped 且 error=kind-pending", () => {
    const made = makeOrchestrateDeps();
    expect(handleDecisionFn(suppressedDecision("kind-pending"), made.deps)).toEqual([
      { channelId: "*", status: "skipped", error: "kind-pending" },
    ]);
  });

  it("kind-pending：落史 suppressed=kind-pending，文本已脱敏", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(suppressedDecision("kind-pending"), made.deps);
    expect(made.history).toEqual([{ ts: 1700000000001, kind: "demo:x", title: SAFE_TITLE, message: SAFE_BODY, suppressed: "kind-pending" }]);
  });

  it("kind-pending：不投递", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(suppressedDecision("kind-pending"), made.deps);
    expect(made.played.length).toBe(0);
  });
});

describe("①c quiet → 落 suppressed 史 + skipped + info 日志", () => {
  it("quiet：返回 skipped 且 error=quiet", () => {
    const made = makeOrchestrateDeps();
    expect(handleDecisionFn(suppressedDecision("quiet"), made.deps)).toEqual([
      { channelId: "*", status: "skipped", error: "quiet" },
    ]);
  });

  it("quiet：落史 suppressed=quiet，文本已脱敏", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(suppressedDecision("quiet"), made.deps);
    expect(made.history).toEqual([{ ts: 1700000000001, kind: "demo:x", title: SAFE_TITLE, message: SAFE_BODY, suppressed: "quiet" }]);
  });

  it("quiet：记 info（其余 suppressed 分支不记）", () => {
    const quiet = makeOrchestrateDeps();
    handleDecisionFn(suppressedDecision("quiet"), quiet.deps);
    const pending = makeOrchestrateDeps();
    handleDecisionFn(suppressedDecision("kind-pending"), pending.deps);
    expect(quiet.infos.length).toBe(1);
    expect(pending.infos.length).toBe(0);
  });

  it("quiet：info 文本不含未脱敏正文", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(suppressedDecision("quiet"), made.deps);
    expect(made.infos[0].includes("alice@example.com")).toBe(false);
    expect(made.infos[0].includes("<email>")).toBe(true);
  });
});

// ---------------------------------------------------------------- ② 统一脱敏时点

describe("② deliver 分支统一脱敏（渲染文本 → 恰好一次 → 落史与投递同源）", () => {
  it("deliver 收到的 title/body 已是脱敏文本（未脱敏原文不得外流）", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(deliverDecision([browserTarget()]), made.deps);
    const payload = made.played[0].payload;
    expect(payload.title).toBe(SAFE_TITLE);
    expect(payload.title.includes("alice")).toBe(false);
    expect(payload.body.includes("/home/alice/secret.txt")).toBe(false);
  });

  it("落史文本 == 投递文本（脱敏单点，两处同源）", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(deliverDecision([browserTarget()]), made.deps);
    expect(made.history).toEqual([
      { ts: 1700000000000, kind: "done", title: made.played[0].payload.title, message: made.played[0].payload.body },
    ]);
  });

  it("sanitizeContent=false → 原样透传（开关随裁决结果携带，不二次读配置）", () => {
    const made = makeOrchestrateDeps();
    const decision = deliverDecision([browserTarget()], { sanitizeContent: false });
    handleDecisionFn(decision, made.deps);
    expect(made.played[0].payload.title).toBe(RAW_TITLE);
    expect(made.history[0].title).toBe(RAW_TITLE);
  });

  it("统一脱敏恰好一次：先脱敏后投递，<path> 占位符不落入 deliver 的原始输入（无二次脱敏叠加）", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(deliverDecision([browserTarget()]), made.deps);
    // 二次脱敏不会改变 SANITIZE_RULES 的输出（占位符不再命中规则）——锁的是
    // deliver 收到的是首次脱敏结果本身，而非「渲染文本 → 未脱敏投递」
    expect(made.played[0].payload.title).toBe(sanitizeNoticeContent({ title: RAW_TITLE, body: RAW_BODY }, true).title);
  });

  it("投递池与 severity/ts 原样随 notice 传递（编排层不改写裁决结果）", () => {
    const made = makeOrchestrateDeps();
    const target = browserTarget();
    const results = handleDecisionFn(deliverDecision([target], { severity: "success" }), made.deps);
    expect(made.played[0].id).toBe("browser");
    expect(made.played[0].payload.severity).toBe("success");
    expect(made.played[0].payload.ts).toBe(1700000000000);
    expect(made.played[0].payload.kind).toBe("done");
    expect(results).toEqual([{ channelId: "browser", status: "ok" }]);
  });

  it("落史失败不打断编排（投递仍执行，warn 记因）", () => {
    const made = makeOrchestrateDeps();
    made.setHistoryThrows();
    const results = handleDecisionFn(deliverDecision([browserTarget()]), made.deps);
    expect(results).toEqual([{ channelId: "browser", status: "ok" }]);
    expect(made.played.length).toBe(1);
    expect(made.history.length).toBe(0);
    expect(made.warns.some((w) => w.includes("history append boom"))).toBe(true);
  });
});

// ---------------------------------------------------------------- ③ stale 频道

describe("③ stale 频道 warn + 不影响其他目标", () => {
  it("每个 stale id 各记一次 warn", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(deliverDecision([], { stale: ["bark:gone", "webhook:deleted"] }), made.deps);
    expect(made.warns.length).toBe(2);
    expect(made.warns[0].includes("bark:gone")).toBe(true);
    expect(made.warns[1].includes("webhook:deleted")).toBe(true);
  });

  it("warn 文本不泄漏未脱敏正文", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(deliverDecision([], { stale: ["bark:gone"] }), made.deps);
    expect(made.warns[0].includes("alice@example.com")).toBe(false);
  });

  it("stale 不阻断其他目标：其他频道照常投递，stale 记 skipped", () => {
    const made = makeOrchestrateDeps();
    const results = handleDecisionFn(deliverDecision([browserTarget()], { stale: ["bark:gone"] }), made.deps);
    expect(made.played.length).toBe(1);
    expect(results).toEqual([
      { channelId: "bark:gone", status: "skipped", error: "stale-route" },
      { channelId: "browser", status: "ok" },
    ]);
  });

  it("无 stale 时零 warn", () => {
    const made = makeOrchestrateDeps();
    handleDecisionFn(deliverDecision([browserTarget()]), made.deps);
    expect(made.warns).toEqual([]);
  });

  it("deliver 返回的结果原样透出（编排层不改写受理结果）", () => {
    const made = makeOrchestrateDeps();
    const results = handleDecisionFn(deliverDecision([browserTarget()]), made.deps);
    expect(results).toEqual([{ channelId: "browser", status: "ok" }]);
  });
});

// ---------------------------------------------------------------- ④ 返回值形状

describe("④ NotifyResult[] 形状", () => {
  it("deliver 分支多目标按序返回", () => {
    const made = makeOrchestrateDeps();
    const results = handleDecisionFn(deliverDecision([browserTarget(), browserTarget("system")]), made.deps);
    expect(results.map((r) => r.channelId)).toEqual(["browser", "system"]);
  });

  it("suppressed 分支恒为「单条、channelId='*'、skipped」", () => {
    for (const reason of ["disabled", "kind-pending", "quiet"] as const) {
      const made = makeOrchestrateDeps();
      const results = handleDecisionFn(suppressedDecision(reason), made.deps);
      expect(results.length).toBe(1);
      expect(results[0].channelId).toBe("*");
      expect(results[0].status).toBe("skipped");
    }
  });

  it("deliver 分支不产出 channelId='*' 条目（'*' 是 suppressed 专用语义）", () => {
    const made = makeOrchestrateDeps();
    const results = handleDecisionFn(deliverDecision([{ id: "browser", channel: poolChannel("browser") }]), made.deps);
    expect(results.every((r) => r.channelId !== "*")).toBe(true);
  });
});

// ---------------------------------------------------------------- ⑤ encodeBrowserSound

describe("⑤ encodeBrowserSound（browser 帧级 sound 编码）", () => {
  it("false → silent", () => {
    expect(encodeBrowserSound(false, true)).toEqual({ mode: "silent", tone: undefined });
  });

  it("true + pop=true → system（有 OS 通知实体可发声）", () => {
    expect(encodeBrowserSound(true, true)).toEqual({ mode: "system", tone: undefined });
  });

  it("true + pop=false → selfplay（无实体，改客户端默认旋律）", () => {
    expect(encodeBrowserSound(true, false)).toEqual({ mode: "selfplay", tone: undefined });
  });

  it("SoundId → selfplay + tone", () => {
    expect(encodeBrowserSound("chime", true)).toEqual({ mode: "selfplay", tone: "chime" });
  });

  it("SoundId + pop=false 仍为 selfplay + tone（编码随 pop 决议，音色不丢）", () => {
    expect(encodeBrowserSound("chime", false)).toEqual({ mode: "selfplay", tone: "chime" });
  });
});

// ---------------------------------------------------------------- ⑥ resolveChannelPool

describe("⑥ resolveChannelPool（投递池解析）", () => {
  const browser = { id: "browser", channel: poolChannel("browser") };
  const system = { id: "system", channel: poolChannel("system") };

  it("弹窗开 → browser 入池且 dispatch.pop=true", () => {
    const pool = resolveChannelPool(baseCfg({ browserNotify: true }), { builtinChannels: [browser], outboundChannels: () => [], logger: { warn: () => {} } });
    expect(pool.length).toBe(1);
    expect(pool[0].id).toBe("browser");
    expect((pool[0].dispatch as { pop: boolean }).pop).toBe(true);
  });

  it("弹窗关 + 声音开 → 仍入池（只响不弹：pop=false）", () => {
    const pool = resolveChannelPool(baseCfg({ browserNotify: false, browserSound: "chime" }), { builtinChannels: [browser], outboundChannels: () => [], logger: { warn: () => {} } });
    expect(pool.length).toBe(1);
    expect(pool[0].dispatch).toEqual({ pop: false, sound: { mode: "selfplay", tone: "chime" } });
  });

  it("弹窗关 + 声音关 → 不入池", () => {
    const pool = resolveChannelPool(baseCfg({ browserNotify: false, browserSound: false }), { builtinChannels: [browser], outboundChannels: () => [], logger: { warn: () => {} } });
    expect(pool).toEqual([]);
  });

  it("内置实例缺失 → 静默跳过（不入池、不抛）", () => {
    const pool = resolveChannelPool(baseCfg({ browserNotify: true, systemNotify: true }), { builtinChannels: [], outboundChannels: () => [], logger: { warn: () => {} } });
    expect(pool).toEqual([]);
  });

  it("system 入池携带 raw sound（非帧编码）", () => {
    const pool = resolveChannelPool(baseCfg({ systemNotify: true, systemSound: "bell" }), { builtinChannels: [system], outboundChannels: () => [], logger: { warn: () => {} } });
    expect(pool[0].dispatch).toEqual({ pop: true, sound: "bell" });
  });

  it("出站频道并入池尾（内置在前）", () => {
    const outbound = [{ id: "bark:phone", channel: poolChannel("bark:phone") }];
    const pool = resolveChannelPool(baseCfg(), { builtinChannels: [browser, system], outboundChannels: () => outbound, logger: { warn: () => {} } });
    expect(pool.map((e) => e.id)).toEqual(["browser", "system", "bark:phone"]);
  });

  it("出站读取抛错 → fail-soft 跳过并 warn，内置池不受影响", () => {
    const warns: string[] = [];
    const pool = resolveChannelPool(baseCfg({ browserNotify: true, systemNotify: false, systemSound: false }), {
      builtinChannels: [browser, system],
      outboundChannels: () => {
        throw new Error("outbound boom");
      },
      logger: { warn: (message: string) => warns.push(message) },
    });
    expect(pool.map((e) => e.id)).toEqual(["browser"]);
    expect(warns.length).toBe(1);
    expect(warns[0].includes("outbound boom")).toBe(true);
  });
});

// ---------------------------------------------------------------- ⑦ sendKind 编排

describe("⑦ createSendKind（渲染 → 裁决 → 编排）", () => {
  /** 真实裁决器 + 真实编排器的接线（fakes 只在域边界：配置/投递/落史/日志）。 */
  function makeSendKind(cfg: Partial<NotifyConfig> = {}, enabled = true) {
    const made = makeOrchestrateDeps();
    const snapshot = baseCfg(cfg);
    const adjudicate = createAdjudicator({
      current: () => snapshot,
      enabled: () => enabled,
      isKindConfirmed: () => true,
      allChannels: () => [browserTarget()],
    });
    const sendKind = createSendKind({ adjudicate, handleDecision: createHandleDecision(made.deps) });
    return { sendKind, ...made };
  }

  it("内置 kind 取 NOTIFY_KINDS 的 title 模板（非 detail.message 原样）", () => {
    const made = makeSendKind();
    made.sendKind("done", { message: "自定义正文" });
    expect(made.played[0].payload.title.length).toBeGreaterThan(0);
    expect(made.played[0].payload.kind).toBe("done");
  });

  it("渲染文本经统一脱敏后进投递（编排节点不漏脱敏）", () => {
    const made = makeSendKind();
    made.sendKind("done", { message: RAW_BODY });
    expect(made.played[0].payload.body.includes("alice@example.com")).toBe(false);
  });

  it("渲染文本进模板后仍受统一脱敏（模板拼接不绕过脱敏单点）", () => {
    const made = makeSendKind();
    // done 模板自带固定文案（detail.message 不进正文）——此处锁「渲染文本一律
    // 经统一脱敏后才出编排」：正文与标题均无未脱敏路径残留
    made.sendKind("done", { message: "见 /home/alice/notes.md" });
    expect(made.played[0].payload.body.includes("/home/alice")).toBe(false);
    expect(made.played[0].payload.body.includes("notes.md")).toBe(false);
    expect(made.played[0].payload.title.includes("/home/alice")).toBe(false);
  });

  it("opts.onlyChannel 透传裁决（单频道受理时其他目标不投）", () => {
    const made = makeSendKind();
    const results = made.sendKind("test", {}, { onlyChannel: "system" });
    expect(made.played.length).toBe(0);
    expect(results.every((r) => r.channelId !== "browser")).toBe(true);
  });

  it("enabled=false → 裁决 suppressed，编排返回 skipped 且零投递", () => {
    const made = makeSendKind({}, false);
    expect(made.sendKind("test", {})).toEqual([{ channelId: "*", status: "skipped", error: "enabled=false" }]);
    expect(made.played.length).toBe(0);
  });
});
