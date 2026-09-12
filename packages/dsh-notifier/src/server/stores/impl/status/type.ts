/**
 * dsh-notifier stores 域 —— 频道投递状态自己的形状。
 *
 * 事件流的实时性由帧出口与 SSE 承担；这里只放「持久事实」：
 * 重启后设置页仍能看到各频道最近一次投递终态。条目与装配入参都只对状态这一块
 * 成立，因此不进 `shared/`。
 */
import type { LoggerPort } from "../../../shared/type.ts";

/** 单频道投递状态条目。 */
export interface ChannelStatusEntry {
  /** 最近一次投递的时间戳（毫秒）。 */
  lastTs: number;
  /** 最近一次投递终态。 */
  lastStatus: "ok" | "failed";
  /** 最近一次失败的错误摘要（ok 时缺省）。 */
  lastError?: string;
  /** 连续失败计数（成功即清零）。 */
  failStreak: number;
}

/** 频道投递状态的装配入参。 */
export interface StatusDeps {
  /** 写入失败出口（record 为 fire-and-forget，失败无返回值可承载）。 */
  logger: LoggerPort;
}
