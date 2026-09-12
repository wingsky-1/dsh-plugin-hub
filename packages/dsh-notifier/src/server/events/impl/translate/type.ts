/**
 * dsh-notifier events 域 —— 翻译块自己的形状：宿主事件进、通知请求出。
 * 种类词汇归下游（裁决的坐标系，见 `../../deps.ts`），本块只往里填。
 */
import type { NotifyRequest } from "../../deps.ts";

/**
 * 翻译结果。大多数宿主事件都不构成通知，这是常态而不是异常路径。
 * 与「开关关着」是两回事：这里说「这件事不构成通知」，后者由裁决层回答。
 */
export type Translation = { ok: true; request: NotifyRequest } | { ok: false };

/** 渲染一条通知需要的事实（不含工具参数等敏感信息）。 */
export interface NotifyDetail {
  tool?: string;
  taskTitle?: string;
  reason?: string;
  question?: string;
  durationMs?: number;
  turn?: number;
  step?: number;
  message?: string;
}

/** 一条通知的文案：标题，以及由详情渲染出的正文。 */
export interface KindText {
  title: string;
  body: (detail: NotifyDetail) => string;
}
