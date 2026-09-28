/**
 * dsh-notifier pipeline 域 —— 投递块自己的形状。
 */
import type { PipelineDeps } from "../../deps.ts";

export type DispatchPort = Pick<PipelineDeps, "channels" | "stores">;

/** 单次投递的结果（经投递出口的签名可达，不引 channels 实现）。 */
export type DeliverOutcome = Awaited<ReturnType<DispatchPort["channels"]["deliver"]>>[number];

/**
 * 一个目标类型的投递节奏：出口只回答「这次失败能不能重试」，次数、退避与节流归本块。
 * 数值为 0 一律表示该机制关闭；`backoffMs` 是线性退避基数（第 n 次重试前等 n 倍）。
 */
export interface DispatchPolicy {
  maxRetries: number;
  backoffMs: number;
  maxInflight: number;
  throttleMs: number;
}

/**
 * 等在门外的一条投递：开投与取消是**两个动作**。
 *
 * 只存开投闭包的话，卸载就拿不到这条排队项——既不能让它开投（卸载后还在发通知），也没法
 * 结算它（它的 promise 永远挂着，调用方的 `Promise.all` 跟着挂）。
 */
export interface QueuedDelivery {
  /** 拿到槽位时开投。 */
  start: () => void;
  /** 卸载时结算这一条：resolve 一个 skipped，不开投、也不碰在途计数（它没占过槽位）。 */
  cancel: () => void;
}

/** 单个频道的节奏状态，键 = `channelId`（跨配置变更延续）；门与节流共用一条记录。 */
export interface ChannelRhythm {
  /** 上一次投递的开始时点（毫秒）；0 = 还没投递过。 */
  lastAt: number;
  inflight: number;
  /** 等在门外的投递（队列无上限）。 */
  queue: QueuedDelivery[];
}
