/**
 * dsh-notifier — pipeline/interface.ts：推送管线域唯一对外引用面。
 *
 * PR2（T2-1）：本域从「纯函数提炼」升级为「裁决/投递工厂」——createAdjudicator
 * 承载 current() 单刻快照（B-2）与 enabled→确认→免打扰→路由→播放决议全链；
 * createDeliverer 承载单频道 fail-soft 投递与终态上报（DeliverDeps 注入，内置
 * 频道播放经 play 值传递、不持快照引用——D23）。域间依赖全部经注入面显式化
 * （pipeline 对 sdk/config 仅 type+值按 §4 图；sdk 经 createAdjudicator/
 * createDeliverer + 结果类型消费本域）。
 */
import type { NotifyConfig, SoundId, SoundSetting } from "../config/interface.ts";
import type { NotifyChannel, NotifySeverity, NotifyResult, NotifySentEvent } from "../sdk/interface.ts";

export { isBuiltinKind, isKindConfirmed, resolveRoutes, createAdjudicator } from "./adjudicate.ts";
export { truncateCodePoints, createDeliverer } from "./deliver.ts";

/** 内置 browser 频道播放决议（browser 帧级 sound；裁决时随快照解析）。 */
export interface BrowserDispatchSpec {
  pop: boolean;
  sound: { mode: "silent" | "system" | "selfplay"; tone?: SoundId };
}

/** 内置 system 频道播放决议（raw SoundSetting 直传 system.notify；裁决时随快照解析）。 */
export interface SystemDispatchSpec {
  pop: boolean;
  sound: SoundSetting;
}

/** 单频道投递目标（内置频道携带播放决议；出站频道走 channel.send）。 */
export interface ResolvedTarget {
  id: string;
  channel: NotifyChannel;
  dispatch?: BrowserDispatchSpec | SystemDispatchSpec;
}

/** 投递池条目（内置频道启用条件与播放决议在裁决时随快照解析）。 */
export interface ChannelPoolEntry {
  id: string;
  channel: NotifyChannel;
  dispatch?: BrowserDispatchSpec | SystemDispatchSpec;
}

/** 裁决通过的投递通知（body 已脱敏——统一时点之后；T2-3 落地前为渲染时态，
 *  编排层保留单变换位）。 */
export interface AdjudicatedNotice {
  kind: string;
  title: string;
  body: string; // 已脱敏（统一时点之后；T2-3 落地前为渲染时态）
  severity?: NotifySeverity;
  /** ts = 裁决时刻。 */
  ts: number;
  targets: ResolvedTarget[];
  /** stale = kindRoutes 指向已删频道（记 skipped）。 */
  stale: string[];
}

/** 仅裁决层三值；merged 属事件源级轨道（不并入）。 */
export type SuppressReason = "disabled" | "kind-pending" | "quiet";

/** 裁决结果分叉（suppressed 携带已脱敏文本——统一时点之后；形状契约 §5）。 */
export type AdjudicateResult =
  | { decision: "suppressed"; reason: SuppressReason; kind: string; title: string; body: string; ts: number }
  | { decision: "deliver"; notice: AdjudicatedNotice };

/** 裁决输入（title/body 已渲染；ts = 裁决时刻）。 */
export interface AdjudicateOptions {
  kind: string;
  title: string;
  body: string;
  severity?: NotifySeverity;
  ts: number;
  /** per-channel 测试等场景：跳过免打扰。 */
  bypassQuiet?: boolean;
  onlyChannel?: string;
}

/** createAdjudicator 注入面（current() 单刻快照：每次裁决恰好调用 1 次，B-2）。 */
export interface AdjudicateDeps {
  /** 当前生效配置读取器（单刻快照；派生闭包一律经快照取值，不得自行调用）。 */
  current(): NotifyConfig;
  /** 总开关（enabled=false → suppressed "disabled"）。 */
  enabled(): boolean;
  /** kind 确认判定（内置恒真；动态 kind 查快照 allowKinds）。 */
  isKindConfirmed(kind: string, snapshot: NotifyConfig): boolean;
  /** 投递集合解析（内置频道启用条件 + 播放决议随快照解析；出站频道同步并入）。 */
  allChannels(snapshot: NotifyConfig): ChannelPoolEntry[];
}

/** 投递载荷（title/body 已按频道能力截断；play 与 channel.send 共用）。 */
export interface DeliverPayload {
  title: string;
  body: string;
  kind: string;
  ts: number;
  severity?: NotifySeverity;
}

/** createDeliverer 注入面（play 值传递 target.dispatch，不持快照引用——D23）。 */
export interface DeliverDeps {
  /** 频道投递终态落盘（status 文件；错误文本已由调用方脱敏）。 */
  recordStatus(channelId: string, status: "ok" | "failed", error?: string): void;
  /** 投递终态事件（'wingsky-notify/sent'；装配层 try/catch 包裹）。 */
  emitSent(payload: NotifySentEvent): void;
  /** 通知级历史落盘（每条投递恰好 1 次；fire-and-forget 防抛由注入方保证）。 */
  appendHistory(entry: { ts: number; kind: string; title: string; message: string; suppressed?: string }): void;
  /** 内置频道播放执行（带 dispatch 的目标经此值传递播放；同步广播或 Promise 终态）。 */
  play(target: ResolvedTarget, payload: DeliverPayload): void | Promise<void>;
}

/** 单次投递编排（notice → NotifyResult[]；含 stale skipped 与逐频道 fail-soft）。 */
export type Deliverer = (notice: AdjudicatedNotice) => NotifyResult[];