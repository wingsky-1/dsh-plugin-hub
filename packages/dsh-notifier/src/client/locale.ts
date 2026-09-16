/**
 * dsh-notifier 客户端 —— 文案绑定。
 *
 * 翻译函数必须能在 apply 期被 locale 服务重绑（切语言时订阅回调会再绑一次），而它又被全文
 * 一百多处调用点引用。用 const 容器承载「当前绑定」把这份可变状态显式化：页面级共享是刻意的
 * ——一个页面只有一份语言。
 *
 * 未装配时回落 key 本体：宿主没提供 locale 服务时界面照常渲染（显示 key 而不是崩）。
 */

export type Translate = (key: string, params?: Record<string, unknown>) => string;

/** 未装配时的回落：key 即文案。 */
const fallbackTranslate: Translate = (key) => String(key);

const binding: { current: Translate } = { current: fallbackTranslate };

/** 装配 / 重绑翻译函数（apply 期与 locale 订阅回调调用）。 */
export function bindTranslate(next: Translate): void {
  binding.current = next;
}

/** 当前翻译函数。 */
export const t: Translate = (key, params) => binding.current(key, params);
