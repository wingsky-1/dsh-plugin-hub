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

/** 单个频道的节奏状态，键 = `channelId`（跨配置变更延续）；门与节流共用一条记录。 */
export interface ChannelRhythm {
  /** 上一次投递的开始时点（毫秒）；0 = 还没投递过。 */
  lastAt: number;
  inflight: number;
  /** 等在门外的投递（队列无上限）。 */
  queue: Array<() => void>;
}
