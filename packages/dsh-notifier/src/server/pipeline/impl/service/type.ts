/**
 * dsh-notifier pipeline 域 —— 编排块自己的形状。
 */
import type { DeliverPort, EffectiveConfig, FramePort, HistoryEntry } from "../../deps.ts";

/**
 * 裁决管线的装配入参：本域拿不到的东西。
 *
 * 落盘位置、通知文案、投递实现都不在其中——它们是各自归属域的知识。本域只要能力，
 * 不要实现：拿到 `deliver` 这个动作，拿不到投递域的状态；拿到 `readConfig` 这个读面，
 * 也拿不到设置域的快照与写队列。
 */
export interface PipelineDeps {
  /** 总开关：组合层入口给的值，不落盘、不进设置层，因此装配期定下后不再变。 */
  enabled: boolean;
  /**
   * 读当前生效设置。
   *
   * 取函数而不是装配期快照：设置在本域看不见的地方被改（用户在设置页提交），快照在
   * 那一刻失效，而下一次裁决读到的仍是旧值——症状是「改了设置不生效」。
   */
  readConfig(): EffectiveConfig;
  /** 投递出口（channels 契约）。 */
  deliver: DeliverPort;
  /** 频道终态写入（stores 契约）。 */
  recordStatus(channelId: string, status: "ok" | "failed", error?: string): void;
  /** 历史写入（stores 契约）。 */
  appendHistory(entry: HistoryEntry): void;
  /** 帧出口：组合根接宿主事件总线，api 域监听后经 SSE 送页面。 */
  emitFrame: FramePort;
}
