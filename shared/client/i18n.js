// dsh 插件家族共享层 — 客户端共享 t 活绑定（issue #348 引入，issue #378 抽取）。
//
// 历史：dsh-mcp-manager / dsh-provider-usage / dsh-web-file-preview 三包各持一份
// 逐字节同构的 src/client/i18n.ts（仅头注释包名不同），统一由本模块提供。
// 各包 client 是多文件模块，翻译函数须跨文件共享且在语言切换时整体重绑：
// `export let t` 为 ESM 活绑定（esbuild 同 bundle 内联为直接变量引用，
// import 方即时可见重绑结果）。未装配时回落 key 本体（行为零变化）。
//
// 准入规则锚点（shared/README.md「插件家族共享层」）：本模块的模块级可变状态
// （t）满足「bundle 私有 + 显式生命周期契约（bindLocale/disposer 配对）+ 不参与
// 包间共享状态」——每包独立构建 client.js，各含一份本模块内联副本，包间互不干扰。
// 若未来客户端构建改为跨包共享 chunk，须重新验证活绑定语义（见 README 准入规则）。

/**
 * 当前翻译函数（apply 时由各包 index.ts 经 bindLocale 装配）。
 * 未装配时回落 key 本体（行为零变化）。
 * @type {(key: string, params?: Record<string, unknown>) => string}
 */
export let t = function (key) {
  return key;
};

/**
 * 装配/重绑翻译函数（官方 ctx.locale.bind(ns) 产物；语言切换 subscribe 内重调）。
 * @param {any} locale - 宿主 locale 服务（须实现 bind）。
 * @param {string} ns - 本插件字典命名空间。
 */
export function bindLocale(locale, ns) {
  if (locale && typeof locale.bind === "function") {
    t = locale.bind(ns);
  }
}
