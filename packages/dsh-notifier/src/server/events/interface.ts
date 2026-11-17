/**
 * dsh-notifier events 域 —— **对外契约**：宿主事件 → 通知请求。
 *
 * 本域是**适配层**：把宿主的说法（`approval/request`、`turn/end`……）翻译成裁决域的词汇
 * （`ask`、`done`……）。它不投递、不落盘、不加工文案，**也不判断该不该发**——请求照样
 * 产出，开关与免打扰由裁决层回答（开关在变化，而本域只在事件到达那一刻才可能去看它）。
 *
 * 审批与提问是宿主的两条 waterfall：组合根负责转发之后调 `next()`，漏掉就等于替所有人
 * 否决了那次审批，而症状与本域毫无字面关联。
 */
import type { EventsDeps } from "./deps.ts";
import { eventListener } from "./impl/listen/index.ts";

// 宿主事件面与 agent 注册表面：组合根照着接事件总线与 `ctx.agents`。
export type { AgentRegistryPort, HostEventPort } from "./deps.ts";

/** 装配事件订阅（组合根在 `apply` 期调用一次）。 */
export function installEvents(deps: EventsDeps): void {
  eventListener.install(deps);
}

/** 摘除全部订阅（与 `installEvents` 配对；重复调用无害）。 */
export function releaseEvents(): void {
  eventListener.release();
}
