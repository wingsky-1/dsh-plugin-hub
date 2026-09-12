/**
 * dsh-notifier — L0 消费方类型编译用例（包导出面契约）。
 *
 * 为什么存在：包导出面（lib/index.d.ts）是外部插件唯一的类型入口，而重构前
 * test/ 全量 @ts-nocheck、根 typecheck 又不编译 test/ —— 这一面没有任何编译期
 * 消费者（「类型面双重空白」）。本文件以外部消费方视角只 import 包导出面，用
 * 类型级断言锁死 SDK ABI 与能力契约：签名或联合类型漂移即 tsc 红。
 *
 * 编译面接线：test/tsconfig.json（noEmit + rewriteRelativeImportExtensions）
 * 由 scripts/test/service-contract-wiring.test.ts 以真实 tsc 编译，随
 * pnpm test:scripts 无条件执行。文件内的运行时断言只是「用例没被绕开」的护栏，
 * 本文件的判据在编译期。
 *
 * 覆盖纪律（#733 M0c）：导出面快照门禁（scripts/data/dsh-notifier-export-surface.json）
 * 的 declBlocks（入库基线 96 条）**全部是 `export declare const/function/class`**，对
 * interface / type 体零覆盖——加一个联合成员、给接口加字段时快照不会红。故类型面由本
 * 文件的「类型体快照锚」兜住：包导出面 28 个类型导出**逐个**一条 `Equal<T, 完整字面量>`，
 * 成员增删 / 字段改型 / 可选性变化都会编译报错。
 *
 * 锚条数口径（#733 M2 核对后修正旧注释）：本文件的编译期锚共 **49 条**
 * `type _X = Expect<...>` —— 28 条类型体快照锚（上述「逐个覆盖」）+ 21 条 ABI / 能力
 * 契约 / 路由面 / 常量面锚。旧注释把「28」（导出面 isType 符号数）写成了锚数，两者不是
 * 一回事；本文件末尾的「头部注释口径自检」用机器断言把这两个数钉住（#10 纪律：自述必须
 * 有机器锁定，否则长期反向）。
 *
 * 面口径（#733 M2-3.2）：本文件按**源码面**（`../../src/index.ts`）导入，锚的是域内类型
 * 体；**产物面**（按包名取 `lib/index.d.ts`）的跨包可达性判据单列在
 * `test/integration/consumer-product-face.ts` —— 声明合并只写进源 `.d.ts`、从未进产物
 * 这类缺陷只有在产物面才可见（源码面导入会让 `src/index.ts` 直接进编译程序而掩盖它）。
 *
 * 写死期望值的纪律：期望值必须是**独立字面量**。用 `T["m"]` 自引用、或 import 包内
 * 未导出类型当期望值，会让两侧同步漂移、锚退化为恒真。未进包导出面的依赖域类型
 * （HistoryStore / SseHub / SystemNotifier / DoneBatcher / ConfigPort 等）一律按结构
 * 写死为本文件的 Shape 别名。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Agent, AgentStatus } from "@deepseek-ai/dsh-agent";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApprovalOutcome, ApprovalRequestEvent } from "@deepseek-ai/dsh-user-approval/types";
import type { ServerResponse } from "node:http";
import {
  BUILTIN_CHANNELS,
  DEFAULT_CONFIG,
  KIND_SEVERITY,
  ROUTES,
  apply,
  applyConfigPatch,
} from "../../src/index.ts";
import type {
  BarkChannelConfig,
  BarkLevel,
  ChannelCapabilities,
  ChannelStatusEntry,
  EventHandlers,
  EventHandlersDeps,
  KindRegistration,
  MigrationOutcome,
  NotifierApplyConfig,
  NotifierService,
  NotifierServiceDeps,
  NotifierServiceInternal,
  NotifyChannel,
  NotifyConfig,
  NotifyDetail,
  NotifyRequest,
  NotifyResult,
  NotifySeverity,
  PatchResult,
  QuietHoursConfig,
  RouteDeps,
  SettingInvalid,
  SettingsBridge,
  SoundChannel,
  SoundId,
  SoundSetting,
  StatusStore,
  SystemTone,
} from "../../src/index.ts";

/** 双向类型相等（编译期判据：任一侧漂移即 false）。 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** 编译期闸门：泛型实参不是 true 就报错。 */
type Expect<T extends true> = T;

// ---------------------------------------------------------------- 未导出依赖域形状
// 消费者无法命名这些类型（不在包导出面），故按结构写死期望值；引用实现侧类型会让
// 锚与被测类型同步漂移、退化为恒真，故宁可重复写一遍结构。

/** stores 域 HistoryEntry / HistoryStore（src/stores/history.ts）。 */
type HistoryEntryShape = {
  ts: number;
  kind: string;
  title: string;
  message: string;
  suppressed?: string;
};
type HistoryStoreShape = {
  append(entry: HistoryEntryShape): void;
  read(): Promise<Array<Record<string, unknown>>>;
  clear(): Promise<number>;
};

/** sdk 域 NotifySentEvent（src/sdk/interface.ts；有意不进包导出面）。 */
type NotifySentEventShape = {
  kind: string;
  title: string;
  message: string;
  channelId: string;
  status: "ok" | "failed";
  error?: string;
  ts: number;
};

/** dsh-agent 的 `'agent/error'` / `'agent/turn-stopping'` 官方载荷：官方在
 * `Events` 上**内联**声明结构、未导出具名别名，故按结构独立写死为期望值
 * （引用实现侧派生的 `Parameters<Events[...]>[0]` 会让锚与被测类型同步漂移、退化为恒真）。 */
type AgentErrorPayloadShape = { agent: Agent; turn: number; step: number; error: unknown };
type AgentTurnStoppingPayloadShape = { agent: Agent; turn: number; signal: AbortSignal };

/** config 域 WebhookChannelConfig / ChannelConfig 联合（src/config/config.ts）。 */
type WebhookChannelConfigShape = {
  id: string;
  name?: string;
  type: "webhook";
  url: string;
  enabled: boolean;
  auth: "none" | "bearer" | "basic" | "header";
  token?: string;
  username?: string;
  password?: string;
  headerName?: string;
  headerValue?: string;
  preset?: "ntfy" | "gotify" | "custom";
  template?: string;
  timeoutSec?: number;
};
type ChannelConfigShape = BarkChannelConfig | WebhookChannelConfigShape;

/** pipeline 域投递决议与载荷（src/pipeline/interface.ts）。 */
type BrowserDispatchSpecShape = {
  pop: boolean;
  sound: { mode: "silent" | "system" | "selfplay"; tone?: SoundId };
};
type SystemDispatchSpecShape = { pop: boolean; sound: SoundSetting };
type ResolvedTargetShape = {
  id: string;
  channel: NotifyChannel;
  dispatch?: BrowserDispatchSpecShape | SystemDispatchSpecShape;
};
type DeliverPayloadShape = {
  title: string;
  body: string;
  kind: string;
  ts: number;
  severity?: NotifySeverity;
};

/** server 域 SseHub / SystemNotifier（src/server/sse-bus.ts、src/server/system-notifier.ts）。 */
type SseEvictStatsShape = { close: number; error: number; limit: number; stalled: number; maxage: number; destroyed: number };
type SseConnHealthShape = { ageMs: number; lastWriteAgoMs: number; stalledMs: number };
type SseHubShape = {
  register(res: ServerResponse): void;
  broadcast(payload: Record<string, unknown>): void;
  framesSince(since: number): Array<Record<string, unknown> & { seq: number }>;
  size(): number;
  evictStats(): SseEvictStatsShape;
  connHealth(now?: number): SseConnHealthShape[];
  dispose(): void;
};
type SystemNotifierShape = {
  notify(pop: boolean, tone: SoundSetting, title: string, message: string): Promise<boolean>;
};

/** config 域 settings 最小服务面（src/config/settings.ts）。 */
type OwnerScopeLikeShape = {
  get(): NotifyConfig;
  watch(cb: (next: NotifyConfig, prev: NotifyConfig) => void): () => void;
  update(patch: object): Promise<void>;
};
type SettingsServiceLikeShape = {
  register(ns: string, schema: unknown, options?: { base?: unknown }): OwnerScopeLikeShape;
  describe(options?: { redactSecrets?: boolean }): Array<{ ns: string; user?: unknown; revision: number }>;
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>;
};

/** events 域 DoneBatcher / SubagentOwnership（src/events/aggregate.ts、src/events/agent-session.ts）。 */
type DoneBatcherShape = {
  enqueue(kind: string, title: string | undefined, durationMs: number): void;
  flush(): void;
  dispose(): void;
};
type SubagentOwnershipShape = {
  get(id: string): Agent | undefined;
  isOwnedBy(id: string, owner: Agent): boolean;
};

// ---------------------------------------------------------------- SDK ABI 逐方法锚
// 消费方按这些签名调用，逐条锁死（与下方类型体快照锚互补：这里给局部签名的可读判据）。

type _ApiVersion = Expect<Equal<NotifierService["apiVersion"], 1>>;
type _RegisterKind = Expect<Equal<NotifierService["registerKind"], (reg: KindRegistration) => void>>;
type _ConfirmKind = Expect<Equal<NotifierService["confirmKind"], (kind: string, confirmed: boolean) => void>>;
type _ListKinds = Expect<Equal<NotifierService["listKinds"], () => Array<{ id: string; label: string; confirmed: boolean }>>>;
type _RegisterChannel = Expect<Equal<NotifierService["registerChannel"], (ch: NotifyChannel) => void>>;
type _Send = Expect<Equal<NotifierService["send"], (req: NotifyRequest) => Promise<NotifyResult[]>>>;
type _SendKind = Expect<
  Equal<
    NotifierServiceInternal["sendKind"],
    (kind: string, detail?: NotifyDetail, opts?: { bypassQuiet?: boolean; onlyChannel?: string }) => NotifyResult[]
  >
>;

// ---------------------------------------------------------------- 请求面与能力契约

type _Severity = Expect<Equal<NotifySeverity, "info" | "success" | "warning" | "failure">>;
type _Data = Expect<Equal<NotifyRequest["data"], Record<string, string> | undefined>>;
type _TitleMaxLen = Expect<Equal<ChannelCapabilities["titleMaxLen"], number>>;
type _MaxBodyLen = Expect<Equal<ChannelCapabilities["maxBodyLen"], number>>;
type _MergeTitleIntoBody = Expect<Equal<ChannelCapabilities["mergeTitleIntoBody"], boolean | undefined>>;
type _Retry = Expect<Equal<ChannelCapabilities["retry"], { maxRetries: number; backoffMs?: number } | undefined>>;
type _MaxInflight = Expect<Equal<ChannelCapabilities["maxInflight"], number | undefined>>;

// ---------------------------------------------------------------- 路由面契约（结构化字面量：server 不 import sdk 的前提）

type _SendTest = Expect<
  Equal<RouteDeps["sendTest"], (channelId?: string) => Array<{ channelId: string; status: string; error?: string }>>
>;
type _StatusReader = Expect<Equal<RouteDeps["statusReader"], () => Promise<Record<string, unknown>>>>;
type _RouteListKinds = Expect<Equal<RouteDeps["listKinds"], () => Array<{ id: string; label: string; confirmed: boolean }>>>;
type _PatchResult = Expect<Equal<ReturnType<typeof applyConfigPatch>, Promise<PatchResult>>>;

// ---------------------------------------------------------------- 常量与配置面

type _BuiltinChannels = Expect<Equal<typeof BUILTIN_CHANNELS, { readonly browser: "browser"; readonly system: "system" }>>;
type _SanitizeDefault = Expect<Equal<NotifyConfig["sanitizeContent"], boolean>>;
type _QuietAllowKinds = Expect<Equal<NotifyConfig["quietHours"]["allowKinds"], string[] | undefined>>;

// ---------------------------------------------------------------- 类型体快照锚（#733 M0c）
// 28 个包导出类型逐个一条：期望值 = 该类型体的完整独立字面量。
// 对照：scripts/data/dsh-notifier-export-surface.json 的 isType:true 条目。

/** 类型 1/28：NotifierService（src/sdk/interface.ts）。 */
type _NotifierServiceShape = Expect<
  Equal<
    NotifierService,
    {
      readonly apiVersion: 1;
      registerKind(reg: KindRegistration): void;
      confirmKind(kind: string, confirmed: boolean): void;
      listKinds(): Array<{ id: string; label: string; confirmed: boolean }>;
      registerChannel(ch: NotifyChannel): void;
      send(req: NotifyRequest): Promise<NotifyResult[]>;
    }
  >
>;

/** 类型 2/28：NotifierServiceInternal（src/sdk/interface.ts；extends NotifierService + sendKind）。 */
type _NotifierServiceInternalShape = Expect<
  Equal<
    NotifierServiceInternal,
    {
      readonly apiVersion: 1;
      registerKind(reg: KindRegistration): void;
      confirmKind(kind: string, confirmed: boolean): void;
      listKinds(): Array<{ id: string; label: string; confirmed: boolean }>;
      registerChannel(ch: NotifyChannel): void;
      send(req: NotifyRequest): Promise<NotifyResult[]>;
      sendKind(kind: string, detail?: NotifyDetail, opts?: { bypassQuiet?: boolean; onlyChannel?: string }): NotifyResult[];
    }
  >
>;

/** 类型 3/28：NotifierServiceDeps（src/sdk/interface.ts）。 */
type _NotifierServiceDepsShape = Expect<
  Equal<
    NotifierServiceDeps,
    {
      current(): NotifyConfig;
      enabled(): boolean;
      history: HistoryStoreShape;
      logger: { warn: (m: string) => void; info: (m: string) => void };
      outboundChannels(): Array<{ id: string; channel: NotifyChannel }>;
      builtinChannels: Array<{ id: string; channel: NotifyChannel }>;
      recordStatus(channelId: string, status: "ok" | "failed", error?: string): void;
      emitSent(payload: NotifySentEventShape): void;
      setConfirm(kind: string, confirmed: boolean): void;
      play(target: ResolvedTargetShape, payload: DeliverPayloadShape): void | Promise<void>;
    }
  >
>;

/** 类型 4/28：NotifySeverity（src/sdk/interface.ts）。 */
type _NotifySeverityShape = Expect<Equal<NotifySeverity, "info" | "success" | "warning" | "failure">>;

/** 类型 5/28：NotifyRequest（src/sdk/interface.ts）。 */
type _NotifyRequestShape = Expect<
  Equal<
    NotifyRequest,
    {
      source: string;
      kind: string;
      severity: NotifySeverity;
      body: string;
      title?: string;
      data?: Record<string, string>;
    }
  >
>;

/** 类型 6/28：NotifyResult（src/sdk/interface.ts）。 */
type _NotifyResultShape = Expect<
  Equal<NotifyResult, { channelId: string; status: "ok" | "skipped" | "failed"; error?: string }>
>;

/** 类型 7/28：KindRegistration（src/sdk/interface.ts）。 */
type _KindRegistrationShape = Expect<Equal<KindRegistration, { id: string; label: string; channels?: string[] }>>;

/** 类型 8/28：ChannelCapabilities（src/sdk/interface.ts）。 */
type _ChannelCapabilitiesShape = Expect<
  Equal<
    ChannelCapabilities,
    {
      titleMaxLen: number;
      maxBodyLen: number;
      mergeTitleIntoBody?: boolean;
      retry?: { maxRetries: number; backoffMs?: number };
      maxInflight?: number;
    }
  >
>;

/** 类型 9/28：NotifyChannel（src/sdk/interface.ts）。 */
type _NotifyChannelShape = Expect<
  Equal<
    NotifyChannel,
    {
      name: string;
      capabilities: ChannelCapabilities;
      send(payload: { title: string; body: string; kind: string; ts: number; severity?: NotifySeverity }): void | Promise<void>;
    }
  >
>;

/** 类型 10/28：BarkLevel（src/config/config.ts）。 */
type _BarkLevelShape = Expect<Equal<BarkLevel, "active" | "timeSensitive" | "passive" | "critical">>;

/** 类型 11/28：BarkChannelConfig（src/config/config.ts）。 */
type _BarkChannelConfigShape = Expect<
  Equal<
    BarkChannelConfig,
    {
      id: string;
      name?: string;
      type: "bark";
      baseUrl: string;
      deviceKey: string;
      enabled: boolean;
      sound?: string;
      level?: BarkLevel;
      levels?: Record<string, BarkLevel>;
      group?: string;
      icon?: string;
      url?: string;
      badge?: number;
    }
  >
>;

/** 类型 12/28：NotifyConfig（src/config/config.ts）。 */
type _NotifyConfigShape = Expect<
  Equal<
    NotifyConfig,
    {
      notifyAsk: boolean;
      notifyQuestion: boolean;
      notifyTaskDone: boolean;
      notifySubagentDone: boolean;
      notifyTaskError: boolean;
      notifyTurnEnd: boolean;
      systemNotify: boolean;
      browserNotify: boolean;
      notifyWhenVisible: boolean;
      notifySound: boolean;
      browserSound: SoundSetting;
      systemSound: SoundSetting;
      quietHours: QuietHoursConfig;
      errorMergeWindowMs: number;
      askRemindMin: number;
      doneMergeWindowMs: number;
      historyMaxAgeDays: number;
      maxConnections: number;
      channels: ChannelConfigShape[];
      kindRoutes: Record<string, string[]>;
      allowKinds: string[];
      sanitizeContent: boolean;
    }
  >
>;

/** 类型 13/28：QuietHoursConfig（src/config/quiet-hours.ts）。 */
type _QuietHoursConfigShape = Expect<
  Equal<QuietHoursConfig, { enabled: boolean; start: string; end: string; allowKinds?: string[] }>
>;

/** 类型 14/28：SoundId（src/config/config.ts；由 SOUND_IDS 派生）。 */
type _SoundIdShape = Expect<Equal<SoundId, "ding" | "bell" | "chime" | "pop">>;

/** 类型 15/28：SoundSetting（src/config/config.ts）。 */
type _SoundSettingShape = Expect<Equal<SoundSetting, boolean | SoundId>>;

/** 类型 16/28：SoundChannel（src/config/config.ts）。 */
type _SoundChannelShape = Expect<Equal<SoundChannel, "browser" | "system">>;

/** 类型 17/28：NotifierApplyConfig（src/config/config.ts）。 */
type _NotifierApplyConfigShape = Expect<
  Equal<
    NotifierApplyConfig,
    { enabled?: boolean; configFile?: string; toastScript?: string; historyFile?: string; statusFile?: string }
  >
>;

/** 类型 18/28：SettingInvalid（src/config/validators.ts）。 */
type _SettingInvalidShape = Expect<Equal<SettingInvalid, { key: string; hint: string }>>;

/** 类型 19/28：MigrationOutcome（src/config/migrate.ts）。 */
type _MigrationOutcomeShape = Expect<
  Equal<
    MigrationOutcome,
    {
      performed: boolean;
      migrated: boolean;
      rolledBack: boolean;
      skippedCorrupt: boolean;
      skippedIdempotent: boolean;
      resumed: boolean;
    }
  >
>;

/** 类型 20/28：SettingsBridge（src/config/settings-bridge.ts；extends ConfigPort）。 */
type _SettingsBridgeShape = Expect<
  Equal<
    SettingsBridge,
    {
      resolve(): NotifyConfig;
      readUser(): { user: Record<string, unknown>; revision?: number };
      writable(): boolean;
      update(patch: object, expectedRevision?: number): Promise<void>;
      confirmKind(kind: string, confirmed: boolean): Promise<void>;
      entry: Record<string, unknown>;
      getCurrent: () => NotifyConfig;
      getSource: () => NotifyConfig;
      isWritable: () => boolean;
      updateConfig: (patch: object, expectedRevision?: number) => Promise<void>;
      confirmKindToConfig: (kind: string, confirmed: boolean) => Promise<void>;
      getScope: () => OwnerScopeLikeShape | undefined;
      getService: () => SettingsServiceLikeShape | undefined;
    }
  >
>;

/** 类型 21/28：RouteDeps（src/server/routes.ts；extends ConfigPort）。 */
type _RouteDepsShape = Expect<
  Equal<
    RouteDeps,
    {
      resolve(): NotifyConfig;
      readUser(): { user: Record<string, unknown>; revision?: number };
      writable(): boolean;
      update(patch: object, expectedRevision?: number): Promise<void>;
      confirmKind(kind: string, confirmed: boolean): Promise<void>;
      logger: { warn: (message: string) => void; info: (message: string) => void };
      sse: SseHubShape;
      system: SystemNotifierShape;
      history: HistoryStoreShape;
      sendTest(channelId?: string): Array<{ channelId: string; status: string; error?: string }>;
      statusReader(): Promise<Record<string, unknown>>;
      listKinds(): Array<{ id: string; label: string; confirmed: boolean }>;
    }
  >
>;

/** 类型 22/28：PatchResult（src/server/routes.ts）。 */
type _PatchResultShape = Expect<
  Equal<
    PatchResult,
    | { ok: true; value: { user: Record<string, unknown>; revision?: number } }
    | { ok: false; status: number; code: string; response: Record<string, unknown> }
  >
>;

/** 类型 23/28：StatusStore（src/stores/status.ts）。 */
type _StatusStoreShape = Expect<
  Equal<
    StatusStore,
    {
      record(channelId: string, status: "ok" | "failed", error?: string): void;
      read(): Promise<Record<string, ChannelStatusEntry>>;
    }
  >
>;

/** 类型 24/28：ChannelStatusEntry（src/stores/status.ts）。 */
type _ChannelStatusEntryShape = Expect<
  Equal<ChannelStatusEntry, { lastTs: number; lastStatus: "ok" | "failed"; lastError?: string; failStreak: number }>
>;

/** 类型 25/28：EventHandlers（src/events/event-handlers.ts；#733 M2-3.3 起载荷为官方类型）。 */
type _EventHandlersShape = Expect<
  Equal<
    EventHandlers,
    {
      handleApprovalRequest: (req: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>;
      handleInternalService: (name: string) => void;
      handleSessionEvent: (session: Session, event: SessionEvent) => void;
      handleAgentStatus: (payload: { agent: Agent; status: AgentStatus }) => void;
      handleAgentDisposed: (payload: { agent: Agent }) => void;
      handleAgentError: (payload: AgentErrorPayloadShape) => void;
      handleAgentTurnStopping: (payload: AgentTurnStoppingPayloadShape) => Promise<void>;
      hookUserQuestions: () => void;
      dispose: () => void;
    }
  >
>;

/** 类型 26/28：EventHandlersDeps（src/events/event-handlers.ts）。 */
type _EventHandlersDepsShape = Expect<
  Equal<
    EventHandlersDeps,
    {
      getConfig: () => NotifyConfig;
      notify: (kind: string, detail?: NotifyDetail) => boolean;
      appendHistory: (entry: HistoryEntryShape) => void;
      doneBatcher: DoneBatcherShape;
      logger: { warn: (msg: string) => void };
      getAgents: () => SubagentOwnershipShape | undefined;
      getUserQuestionsService: () => { ask?: unknown } | undefined;
    }
  >
>;

/** 类型 27/28：NotifyDetail（src/text/message.ts）。 */
type _NotifyDetailShape = Expect<
  Equal<
    NotifyDetail,
    {
      tool?: string;
      taskTitle?: string;
      reason?: string;
      question?: string;
      durationMs?: number;
      turn?: number;
      step?: number;
      message?: string;
      mergedCount?: number;
      remindMinutes?: number;
      mergedErrors?: string[];
      ts?: number;
    }
  >
>;

/** 类型 28/28：SystemTone（src/text/system-commands.ts）。 */
type _SystemToneShape = Expect<Equal<SystemTone, SoundId | "default">>;

// ---- 负向断言：非法用法必须不可编译（指令本身也受检：错误消失即 unused 报错） ----
// @ts-expect-error severity 只接受四值联合
const badSeverity: NotifyRequest = { source: "s", kind: "k", severity: "critical", body: "b" };
// @ts-expect-error data 只接受 string 值（MVP 透传约束）
const badData: NotifyRequest = { source: "s", kind: "k", severity: "info", body: "b", data: { n: 1 } };
void badSeverity;
void badData;

// ---- 运行时护栏：导出面确实可从包入口取到（判据在编译期，这里只防用例被绕开） ----
describe("运行时护栏：导出面确实可从包入口取到", () => {
  it("内置频道 id 导出面稳定（browser）", () => {
    expect(BUILTIN_CHANNELS.browser).toBe("browser");
  });

  it("内置频道 id 导出面稳定（system）", () => {
    expect(BUILTIN_CHANNELS.system).toBe("system");
  });

  it("完成事件 severity 映射随包导出面可见", () => {
    expect(KIND_SEVERITY.done).toBe("success");
  });

  it("sanitizeContent 默认开启（安全默认）", () => {
    expect(DEFAULT_CONFIG.sanitizeContent).toBe(true);
  });

  it("ROUTES 为客户端路由单一事实源（path map，含 /health 必项）", () => {
    expect(
      typeof ROUTES === "object" && ROUTES !== null && typeof ROUTES.health === "string" && Object.keys(ROUTES).length > 0,
    ).toBeTruthy();
  });

  it("apply 为宿主入口（消费方经 cordis patch 挂载）", () => {
    expect(typeof apply).toBe("function");
  });

  it("applyConfigPatch 随包导出面可用", () => {
    expect(typeof applyConfigPatch).toBe("function");
  });
});

// ---- 头部注释口径自检（#733 M2）：注释里的数字必须能被一条命令证伪 ----
// 旧注释把「导出面 isType 符号数 28」写成了锚数（实际 49），属自述与代码不一致。
// 下面三条把「锚总数」「类型体锚编号自洽」「类型体锚逐个覆盖导出面类型导出」全部
// 机器化——任一漂移即红，不再依赖人记得同步注释。
describe("头部注释口径自检（锚条数 / 类型体锚覆盖不变式）", () => {
  const self = readFileSync(new URL("./consumer-types.test.ts", import.meta.url), "utf8");

  it("注释声明的编译期锚条数与实际一致", () => {
    const anchors = self.match(/^type _[A-Za-z]+ = Expect</gmu) ?? [];
    expect(anchors.length).toBeGreaterThan(0);
    const declared = /本文件的编译期锚共 \*\*(\d+) 条\*\*/u.exec(self);
    expect(declared).not.toBeNull();
    expect(anchors.length).toBe(Number(declared![1]));
  });

  it("「类型 N/28」编号自洽（序号连续、分母一致且等于条数）", () => {
    const numbered = [...self.matchAll(/^\/\*\* 类型 (\d+)\/(\d+)：/gmu)];
    expect(numbered.length).toBeGreaterThan(0);
    const totals = new Set(numbered.map((m) => m[2]));
    expect([...totals]).toHaveLength(1);
    expect(Number([...totals][0])).toBe(numbered.length);
    expect(numbered.map((m) => Number(m[1]))).toEqual(numbered.map((_, i) => i + 1));
  });

  it("每个导出面类型导出都有一条 `<名字>Shape` 类型体锚（逐个覆盖不变式）", () => {
    const baseline: { exports: Array<{ name: string; isType: boolean }> } = JSON.parse(
      readFileSync(new URL("../../../../scripts/data/dsh-notifier-export-surface.json", import.meta.url), "utf8"),
    );
    const typeExports = baseline.exports.filter((e) => e.isType).map((e) => e.name);
    expect(typeExports.length).toBeGreaterThan(0);
    const missing = typeExports.filter((name) => !self.includes(`_${name}Shape = Expect<`));
    expect(missing).toEqual([]);
  });
});
