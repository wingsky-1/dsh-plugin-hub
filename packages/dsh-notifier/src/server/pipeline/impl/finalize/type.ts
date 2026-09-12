/** dsh-notifier pipeline 域 —— 定稿块自己的形状。 */
import type { NotifySeverity } from "../../deps.ts";

/** 强度取值的来源：缺席与「显式写了某档」是两件事，用判别联合分开。 */
export type SeverityChoice = { provided: true; severity: NotifySeverity } | { provided: false };
