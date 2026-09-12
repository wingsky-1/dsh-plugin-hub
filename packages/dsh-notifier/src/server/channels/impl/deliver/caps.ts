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

/** 按码点截断（超长才截）：按 UTF-16 截会腰斩 emoji 代理对，显示成替换符。 */
export function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join("") : text;
}
