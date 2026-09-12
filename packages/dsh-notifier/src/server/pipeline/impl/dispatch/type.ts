/**
 * dsh-notifier pipeline 域 —— 投递块自己的形状。
 */
import type { ChannelsPort, StoresPort } from "../../deps.ts";

/** 投递入参：本块用到的两个域面。 */
export interface DispatchDeps {
  /** 投递出口。 */
  channels: ChannelsPort;
  /** 频道终态写入：重启后设置页仍要看得到上次送到没有。 */
  stores: StoresPort;
}
