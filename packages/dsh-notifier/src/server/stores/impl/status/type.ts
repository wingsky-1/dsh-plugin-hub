/** dsh-notifier stores 域 —— 频道投递状态自己的形状：重启后仍成立的持久事实。 */
import type { DeliverReason, LoggerPort } from "../../../shared/interface.ts";

/** 单频道投递状态条目。 */
export interface ChannelStatusEntry {
  lastTs: number;
  lastStatus: "ok" | "failed";
  /** 失败理由（结构化）；只在失败那一支上（成功记录会把它清掉）。 */
  lastError?: DeliverReason;
  /** 连续失败计数（成功即清零，跨重启延续）。 */
  failStreak: number;
}

/** 频道投递状态的装配入参。 */
export interface StatusDeps {
  /** 写入失败出口（record 为 fire-and-forget，失败无返回值可承载）。 */
  logger: LoggerPort;
}
