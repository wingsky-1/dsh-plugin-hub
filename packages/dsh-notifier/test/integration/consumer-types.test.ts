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
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_CHANNELS,
  DEFAULT_CONFIG,
  KIND_SEVERITY,
  ROUTES,
  apply,
  applyConfigPatch,
} from "../../src/index.ts";
import type {
  ChannelCapabilities,
  KindRegistration,
  NotifierService,
  NotifierServiceInternal,
  NotifyChannel,
  NotifyConfig,
  NotifyDetail,
  NotifyRequest,
  NotifyResult,
  NotifySeverity,
  PatchResult,
  RouteDeps,
} from "../../src/index.ts";

/** 双向类型相等（编译期判据：任一侧漂移即 false）。 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** 编译期闸门：泛型实参不是 true 就报错。 */
type Expect<T extends true> = T;

// ---- SDK ABI：消费方按这些签名调用，逐条锁死 ----
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

// ---- 请求面与能力契约 ----
type _Severity = Expect<Equal<NotifySeverity, "info" | "success" | "warning" | "failure">>;
type _Data = Expect<Equal<NotifyRequest["data"], Record<string, string> | undefined>>;
type _TitleMaxLen = Expect<Equal<ChannelCapabilities["titleMaxLen"], number>>;
type _MaxBodyLen = Expect<Equal<ChannelCapabilities["maxBodyLen"], number>>;
type _MergeTitleIntoBody = Expect<Equal<ChannelCapabilities["mergeTitleIntoBody"], boolean | undefined>>;
type _Retry = Expect<Equal<ChannelCapabilities["retry"], { maxRetries: number; backoffMs?: number } | undefined>>;
type _MaxInflight = Expect<Equal<ChannelCapabilities["maxInflight"], number | undefined>>;

// ---- 路由面契约（结构化字面量：server 不 import sdk 的前提） ----
type _SendTest = Expect<
  Equal<RouteDeps["sendTest"], (channelId?: string) => Array<{ channelId: string; status: string; error?: string }>>
>;
type _StatusReader = Expect<Equal<RouteDeps["statusReader"], () => Promise<Record<string, unknown>>>>;
type _RouteListKinds = Expect<Equal<RouteDeps["listKinds"], () => Array<{ id: string; label: string; confirmed: boolean }>>>;
type _PatchResult = Expect<Equal<ReturnType<typeof applyConfigPatch>, Promise<PatchResult>>>;

// ---- 常量与配置面 ----
type _BuiltinChannels = Expect<Equal<typeof BUILTIN_CHANNELS, { readonly browser: "browser"; readonly system: "system" }>>;
type _SanitizeDefault = Expect<Equal<NotifyConfig["sanitizeContent"], boolean>>;
type _QuietAllowKinds = Expect<Equal<NotifyConfig["quietHours"]["allowKinds"], string[] | undefined>>;

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
