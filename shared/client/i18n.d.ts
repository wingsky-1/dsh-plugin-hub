/** 翻译函数形态（与官方 Translate 一致：key + {name} 占位参数）。 */
export declare type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

/**
 * 当前翻译函数（apply 时由各包 index.ts 经 bindLocale 装配）。
 * 未装配时回落 key 本体（行为零变化）。
 */
export declare let t: TranslateFn;

/**
 * 装配/重绑翻译函数（官方 ctx.locale.bind(ns) 产物；语言切换 subscribe 内重调）。
 * @param locale 宿主 locale 服务（须实现 bind）。
 * @param ns 本插件字典命名空间。
 */
export declare function bindLocale(locale: any, ns: string): void;
