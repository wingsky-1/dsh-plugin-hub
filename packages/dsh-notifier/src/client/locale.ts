/**
 * dsh-notifier 客户端 —— 文案绑定。
 *
 * 翻译函数必须能在 apply 期被 locale 服务重绑（切语言时订阅回调会再绑一次），而它又被全文
 * 一百多处调用点引用。用 const 容器承载「当前绑定」把这份可变状态显式化：页面级共享是刻意的
 * ——一个页面只有一份语言。
 *
 * 未装配时回落 key 本体：宿主没提供 locale 服务时界面照常渲染（显示 key 而不是崩）。
 */

// 翻译函数形态取官方 Translate（@deepseek-ai/dsh-client-locale 再导出
// @deepseek-ai/dsh-client-ui-slots 的权威声明）：本模块不再自带一份手抄形态，
// 上游改签名即判红。仅 import type，编译期擦除、零运行时依赖。
import type { Translate } from "@deepseek-ai/dsh-client-locale/client";
export type { Translate };

/** 未装配时的回落：key 即文案。 */
const fallbackTranslate: Translate = (key) => String(key);

const binding: { current: Translate } = { current: fallbackTranslate };

/** 装配 / 重绑翻译函数（apply 期与 locale 订阅回调调用）。 */
export function bindTranslate(next: Translate): void {
  binding.current = next;
}

/** 当前翻译函数。 */
export const t: Translate = (key, params) => binding.current(key, params);
