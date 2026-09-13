/** dsh-notifier channels 域 —— 各出口的展示上限（出口与投递块共用）。 */
import type { DeliveryTarget } from "./index.ts";

/** 一个出口的展示上限（码点）。 */
export interface DisplayCaps {
  titleMax: number;
  bodyMax: number;
}

/** 各出口的展示上限（值取自 0.2.3 的 channel capabilities）。 */
export const displayCaps: Readonly<Record<DeliveryTarget["type"], DisplayCaps>> = {
  bark: { titleMax: 64, bodyMax: 4096 },
  webhook: { titleMax: 64, bodyMax: 4096 },
  browser: { titleMax: 64, bodyMax: 2048 },
  system: { titleMax: 64, bodyMax: 256 },
};

/** 失败原因上限：状态页只有一行，原因是摘要不是全文（0.2.3 同值）。 */
export const FAILURE_REASON_MAX = 300;

/** 失败原因里附带的响应体摘要上限：各出口自己拼文案，摘要长度是同一条口径。 */
export const RESPONSE_DETAIL_MAX = 200;

/** 按码点截断：定稿与四个出口共用同一份（实现在共享层，这里只是转发，不是第二份副本）。 */
export { truncateCodePoints } from "../../../shared/interface.ts";
