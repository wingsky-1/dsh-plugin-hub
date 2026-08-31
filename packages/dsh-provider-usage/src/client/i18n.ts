/**
 * dsh-provider-usage — 客户端共享 t 引用（issue #348）。
 *
 * client 是多文件模块（index.ts 胶囊/面板 + settings.ts 设置 tab），翻译函数
 * 须跨文件共享且在语言切换时整体重绑：`export let t` 为 ESM 活绑定（esbuild
 * 同 bundle 内联为直接变量引用，import 方即时可见重绑结果）。
 * 未装配时回落 key 本体（行为零变化）。
 */

/** 翻译函数形态（与官方 Translate 一致：key + {name} 占位参数）。 */
export type TranslateFn = (key: string, params?: Record<string, unknown>) => string;

/** 当前翻译函数（apply 时由 index.ts 经 bindLocale 装配）。 */
export let t: TranslateFn = function (key: string): string {
  return key;
};

/**
 * 装配/重绑翻译函数（官方 ctx.locale.bind(ns) 产物；语言切换 subscribe 内重调）。
 */
export function bindLocale(locale: any, ns: string): void {
  if (locale && typeof locale.bind === "function") {
    t = locale.bind(ns) as TranslateFn;
  }
}
