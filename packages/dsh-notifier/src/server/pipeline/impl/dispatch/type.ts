/**
 * dsh-notifier pipeline 域 —— 投递块自己的形状。
 */
import type { DeliverPort } from "../../deps.ts";

/** 投递入参。 */
export interface DispatchDeps {
  /** 投递出口（channels 契约）。 */
  deliver: DeliverPort;
  /** 频道终态写入（stores 契约）：重启后设置页仍要看得到上次送到没有。 */
  recordStatus(channelId: string, status: "ok" | "failed", error?: string): void;
}
