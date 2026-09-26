// shared/client/i18n.ts — 本层的官方类型导入有一条**易被静默吞掉**的前提，先写在这里。
//
// 这两条 import 按「本文件所在目录」向上解析：shared/ 不是 workspace 包，
// 只会走到仓库根 `<repo>/node_modules/@deepseek-ai/*`。前提由三处登记锁住：根
// package.json 的两个 `catalog:` devDependencies（dsh-client-locale /
// dsh-client-ui-slots）+ catalog 版本 + pnpm-lock.yaml，`pnpm install --frozen-lockfile`
// 缺一即失败。
//
// 为什么这条前提仍值得写在本文件里：仓库的 tsconfig.base.json 开了
// `skipLibCheck: true`，被放过的**声明文件**（.d.ts）内模块解析失败零诊断——官方包
// 自带的 .d.ts 一旦在缺依赖的树里解析不到它的上游，LocaleRuntime / Translate 会在
// 声明层静默退化成 `any`，tsc 全绿，护栏形同虚设。本文件自身是 .ts：它那两条 import
// 解析失败会正常报 TS2307（不再静默，这正是转真 TypeScript 顺带收掉的一个洞），但
// 「官方声明 → any」这条链依旧零诊断，故前提仍须由上面三处锁住。
//
// **不要**改用 `--skipLibCheck false` 做门禁：官方自己的 .d.ts 就 import 了本仓未安装的
// dsh-api-remotes 等，那条路会永久判红。
//
// dsh 插件家族共享层 — 客户端共享 t 活绑定（issue #348 引入，issue #378 抽取）。
//
// 历史：dsh-mcp-manager / dsh-provider-usage 两包各持一份
// 逐字节同构的 src/client/i18n.ts（仅头注释包名不同），统一由本模块提供。
// 各包 client 是多文件模块，翻译函数须跨文件共享且在语言切换时整体重绑：
// `export let t` 为 ESM 活绑定（esbuild 同 bundle 内联为直接变量引用，
// import 方即时可见重绑结果）。未装配时回落 key 本体（行为零变化）。
//
// 准入规则锚点（shared/README.md「插件家族共享层」）：本模块的模块级可变状态
// （t）满足「bundle 私有 + 显式生命周期契约（bindLocale/disposer 配对）+ 不参与
// 包间共享状态」——每包独立构建 client.js，各含一份本模块内联副本，包间互不干扰。
// 若未来客户端构建改为跨包共享 chunk，须重新验证活绑定语义（见 README 准入规则）。

import type { LocaleRuntime } from "@deepseek-ai/dsh-client-locale/client";
import type { Translate } from "@deepseek-ai/dsh-client-ui-slots";

/**
 * 翻译函数形态：直接取官方 Translate（key + {name} 占位参数），本层不再自带一份手抄形态
 * ——上游改签名即判红。仅类型导入，编译期擦除，实现（i18n.js）仍零依赖。
 */
export type TranslateFn = Translate;

/**
 * 当前翻译函数（apply 时由各包 index.ts 经 bindLocale 装配）。
 * 未装配时回落 key 本体（行为零变化）。
 */
export let t: Translate = function (key) {
  return key;
};

/**
 * 装配/重绑翻译函数（官方 ctx.locale.bind(ns) 产物；语言切换 subscribe 内重调）。
 *
 * @param locale 宿主 locale 服务读面：**只要求本函数真正消费的那个成员 `bind`**。
 *   刻意不撑成整个 LocaleRuntime——参数面只该描述函数自己用什么。若按调用方的额外需求
 *   撑成四成员，每个只喂 `{ bind }` 的测试都得为它加逃逸口，等于把测试便利写进公共契约。
 *   调用方各自的完整读面由它们自己声明（见 provider-usage 的 `LocalePort`、
 *   lan-proxy 的 `LocalePort`、mcp-manager 的 `McpLocaleService`）。
 *   `null | undefined` 是实现既有降级分支（本文件的 `locale &&` 守卫 + shared/README
 *   登记的「未装配回落 key 本体」），真实调用点 `ctx.get("locale")` 本就可能是 undefined。
 * @param ns 本插件字典命名空间。
 */
export function bindLocale(
  locale: Pick<LocaleRuntime, "bind"> | null | undefined,
  ns: string,
): void {
  if (locale && typeof locale.bind === "function") {
    t = locale.bind(ns);
  }
}
